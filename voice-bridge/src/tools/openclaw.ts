import { spawn } from "node:child_process";
import { config } from "../config.js";
import { log } from "../logger.js";

const { bin, agent, thinking, url } = config.openclaw;

/**
 * The OpenClaw gateway's HTTP surface is the Control UI (not OpenAI-compatible), so we drive the
 * agent through its CLI: `openclaw agent --agent <id> --json --message <prompt>`. That runs one
 * agent turn via the already-running gateway daemon (using its configured model + memory) and
 * prints a JSON result whose reply lives at `finalAssistantVisibleText`.
 *
 * OpenClaw owns long-term memory (SQLite + MEMORY.md / workspace files), so this is the single
 * doorway from the voice brain into "remember / recall / do".
 */
function findReply(node: unknown): string | null {
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if ((k === "finalAssistantVisibleText" || k === "finalAssistantRawText") && typeof v === "string") {
        return v;
      }
      const found = findReply(v);
      if (found != null) return found;
    }
  }
  return null;
}

export function askOpenclaw(prompt: string, timeoutMs = 30000): Promise<string> {
  return new Promise((resolve) => {
    const args = ["agent", "--agent", agent, "--json", "--thinking", thinking, "--message", prompt];
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));

    child.on("error", (e: Error) => {
      clearTimeout(timer);
      log.error("openclaw spawn failed", { err: String(e), bin });
      resolve(`I couldn't run the OpenClaw agent. Is "${bin}" installed and on PATH?`);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        log.error("openclaw agent timed out", { timeoutMs });
        resolve("The OpenClaw backbone took too long to respond.");
        return;
      }
      if (code !== 0) {
        log.error("openclaw agent error", { code, err: err.slice(0, 300) });
        resolve("The OpenClaw backbone returned an error.");
        return;
      }
      try {
        const reply = findReply(JSON.parse(out));
        resolve(reply?.trim() ? reply.trim() : "OpenClaw returned an empty response.");
      } catch (e) {
        log.error("openclaw json parse failed", { err: String(e), sample: out.slice(0, 200) });
        resolve("I got an unreadable response from OpenClaw.");
      }
    });
  });
}

/** Startup health check — true if the gateway HTTP surface is up. */
export async function pingOpenclaw(timeoutMs = 3000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    return res.status > 0; // any HTTP response means the daemon is listening
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
