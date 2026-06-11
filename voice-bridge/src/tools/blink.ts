import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { config } from "../config.js";
import { log } from "../logger.js";

// Blink doorbell: shells out to the Python helper (blinkpy) to poll for events and snap a still,
// then asks an OpenAI vision model who's at the door. Proactive announcements are spoken via TTS
// from index.ts. Blink is cloud-only + an unofficial API, so this is polling, not instant push.

const SNAP_PATH = "/tmp/jarvis-door.jpg";

interface DoorStatus {
  motion_detected: boolean | null;
  last_record: unknown;
  recent_clips: number;
  thumb_ts: string;
}

function runHelper(args: string[], timeoutMs = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.blink.python, [config.blink.helper, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("blink helper timed out"));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `blink helper exited ${code}`));
    });
  });
}

export async function pollDoorbell(): Promise<DoorStatus | null> {
  try {
    return JSON.parse(await runHelper(["poll", config.blink.camera])) as DoorStatus;
  } catch (err) {
    log.error("blink poll failed", { err: String(err) });
    return null;
  }
}

async function snapshot(path: string): Promise<boolean> {
  try {
    await runHelper(["snapshot", config.blink.camera, path], 45000);
    return true;
  } catch (err) {
    log.error("blink snapshot failed", { err: String(err) });
    return false;
  }
}

/** Snap the doorbell and have a vision model describe who/what is there. Returns a spoken sentence. */
export async function describeDoor(): Promise<string> {
  const fallback = "Someone's at the front door.";
  if (!(await snapshot(SNAP_PATH))) return `${fallback} I couldn't grab a snapshot, though.`;
  try {
    const b64 = (await readFile(SNAP_PATH)).toString("base64");
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.openai.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.blink.visionModel,
        max_tokens: 60,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "This is a still from a front-door camera. In ONE short, natural spoken sentence, say who or " +
                  "what is at the door (e.g. a delivery courier with a parcel, a visitor, a person, or nobody " +
                  "clearly visible). Don't mention that it's a camera image.",
              },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      log.error("vision request failed", { status: res.status });
      return fallback;
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const desc = data.choices?.[0]?.message?.content?.trim();
    return desc ? `Someone's at the front door. ${desc}` : fallback;
  } catch (err) {
    log.error("describeDoor error", { err: String(err) });
    return fallback;
  }
}

/**
 * Poll the doorbell; when a NEW clip is recorded (a ring or motion while armed), call onEvent with a
 * spoken announcement. The first poll just sets the baseline (no announcement on startup).
 */
export function startDoorbellWatcher(onEvent: (announcement: string) => Promise<void>): void {
  let baseline: string | null = null;
  let busy = false;

  const tick = async (): Promise<void> => {
    if (busy) return; // don't overlap a slow describe/announce with the next poll
    const status = await pollDoorbell();
    if (!status) return;
    // A recorded clip is the reliable "someone did something" signal (ignore periodic thumbnail bumps).
    const key = `${String(status.last_record ?? "")}|${status.recent_clips}`;
    if (baseline === null) {
      baseline = key;
      return;
    }
    if (key !== baseline) {
      baseline = key;
      busy = true;
      log.info("doorbell event", { last_record: status.last_record, recent_clips: status.recent_clips });
      try {
        await onEvent(await describeDoor());
      } finally {
        busy = false;
      }
    }
  };

  setInterval(() => void tick().catch((e) => log.error("doorbell tick failed", { err: String(e) })), config.blink.pollMs);
  log.info("doorbell watcher started", { camera: config.blink.camera, everySeconds: config.blink.pollMs / 1000 });
}
