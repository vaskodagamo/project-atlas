import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { log } from "../logger.js";

// Saved under an OpenClaw-allowed dir (its workspace by default) so `openclaw message send --media`
// is permitted — /tmp is rejected with "Local media path is not under an allowed directory".
export const DOOR_IMAGE = join(config.blink.mediaDir, "door.jpg");

function ensureMediaDir(): void {
  try {
    mkdirSync(config.blink.mediaDir, { recursive: true });
  } catch (err) {
    log.error("could not create Blink media dir", { dir: config.blink.mediaDir, err: String(err) });
  }
}

function runHelper(args: string[], timeoutMs = 45000): Promise<string> {
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

/** Ask an OpenAI vision model who/what is in a door image. Returns a spoken sentence. */
export async function describeImage(imagePath: string): Promise<string> {
  const fallback = "Someone's at the front door.";
  try {
    const b64 = (await readFile(imagePath)).toString("base64");
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
    log.error("describeImage error", { err: String(err) });
    return fallback;
  }
}

/** On-demand "who's at the door?": snapshot via the helper, then describe it. */
export async function describeDoor(): Promise<string> {
  ensureMediaDir();
  try {
    await runHelper(["snapshot", config.blink.camera, DOOR_IMAGE]);
  } catch (err) {
    log.error("blink snapshot failed", { err: String(err) });
    return "Someone's at the front door. I couldn't grab a snapshot, though.";
  }
  return describeImage(DOOR_IMAGE);
}

interface WatcherMessage {
  event?: boolean;
  image?: string | null;
  clip?: string | null;
  ready?: boolean;
  warn?: string;
  fatal?: string;
  camera?: string;
  interval?: number;
}

/**
 * Spawn the long-lived Python watcher (ONE persistent Blink connection — keeps the token alive and
 * watches both motion clips and button-press thumbnail changes). On each event it provides a captured
 * still (+ clip if configured); we describe it and call onEvent. Auto-restarts if the watcher dies.
 */
export function startDoorbellWatcher(
  onEvent: (announcement: string, imagePath: string | null, clipPath: string | null) => Promise<void>,
): void {
  ensureMediaDir();
  const child: ChildProcess = spawn(
    config.blink.python,
    [config.blink.watcher, config.blink.camera, config.blink.mediaDir, config.blink.media],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let busy = false;
  let buf = "";

  const handleLine = async (line: string): Promise<void> => {
    let msg: WatcherMessage;
    try {
      msg = JSON.parse(line) as WatcherMessage;
    } catch {
      return;
    }
    if (msg.ready) {
      log.info("doorbell watcher ready", { camera: msg.camera, everySeconds: msg.interval });
      return;
    }
    if (msg.fatal) {
      log.error("blink watcher fatal — re-auth needed?", { fatal: msg.fatal });
      return;
    }
    if (msg.warn) {
      log.warn("blink watcher", { warn: msg.warn });
      return;
    }
    if (msg.event && !busy) {
      busy = true;
      log.info("doorbell event", { hasImage: Boolean(msg.image), hasClip: Boolean(msg.clip) });
      try {
        const image = msg.image ?? null;
        const description = image ? await describeImage(image) : "Someone's at the front door.";
        await onEvent(description, image, msg.clip ?? null);
      } finally {
        busy = false;
      }
    }
  };

  child.stdout?.on("data", (d: Buffer) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) void handleLine(line).catch((e) => log.error("doorbell handleLine failed", { err: String(e) }));
    }
  });
  child.stderr?.on("data", (d: Buffer) => log.debug("blink watcher stderr", { msg: d.toString().trim() }));
  child.on("error", (e) => log.error("blink watcher spawn failed", { err: String(e) }));
  child.on("close", (code) => {
    log.warn("blink watcher exited — restarting in 10s", { code });
    setTimeout(() => startDoorbellWatcher(onEvent), 10000);
  });
}
