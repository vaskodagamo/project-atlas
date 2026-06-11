import { spawn } from "node:child_process";
import { config } from "../config.js";
import { log } from "../logger.js";

// Send media (photo OR video) + caption to a Telegram chat using the OpenClaw bot
// (`openclaw message send --media`). Reuses the bot the user set up, so it lands in their Jarvis chat.
export function sendTelegramMedia(target: string, caption: string, mediaPath: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(
      config.openclaw.bin,
      ["message", "send", "--channel", "telegram", "--target", target, "--message", caption, "--media", mediaPath],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      log.warn("telegram send timed out");
      resolve();
    }, 30000);
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      log.error("telegram send spawn failed", { err: String(e) });
      resolve();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) log.error("telegram send failed", { code, err: err.slice(0, 200) });
      else log.info("telegram doorbell photo sent");
      resolve();
    });
  });
}

/** Format a timestamp in Berlin time for captions, e.g. "21.06.2026, 14:05". */
export function berlinTime(): string {
  return new Date().toLocaleString("de-DE", {
    timeZone: "Europe/Berlin",
    dateStyle: "medium",
    timeStyle: "short",
  });
}
