import { EventEmitter } from "node:events";
import { log } from "../logger.js";

const CTRL_C = 3; // ETX

/**
 * Push-to-talk "wake": instead of a spoken wake word, a keypress toggles the conversation.
 * Press Enter or space to START a session (then just talk — server VAD handles turn-taking),
 * press again to END it. Ctrl-C still quits.
 *
 * Needs an interactive terminal (a TTY). Under launchd there's no TTY, so push-to-talk only works
 * when you run `npm start` in Terminal — for an always-on boot service, use a wake-word mode.
 *
 * Emits: "toggle".
 */
export class PushToTalk extends EventEmitter {
  start(): void {
    const stdin = process.stdin;
    if (stdin.isTTY) {
      stdin.setRawMode(true); // deliver each keystroke immediately (space/Enter as single keys)
    } else {
      log.warn("push-to-talk: no TTY detected — only line input (Enter) will work, not single keys");
    }
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", (key: string) => this.onKey(key));
  }

  private onKey(key: string): void {
    if (key.charCodeAt(0) === CTRL_C) {
      // Raw mode swallows the default SIGINT, so re-raise it for the shutdown handler.
      process.kill(process.pid, "SIGINT");
      return;
    }
    if (key === "\r" || key === "\n" || key === " ") {
      this.emit("toggle");
    }
  }

  stop(): void {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

export interface PushToTalk {
  on(event: "toggle", listener: () => void): this;
  emit(event: "toggle"): boolean;
}
