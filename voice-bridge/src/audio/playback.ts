import { spawn, type ChildProcess } from "node:child_process";
import { REALTIME_SAMPLE_RATE } from "../config.js";
import { log } from "../logger.js";
import { int16ToBuffer } from "./pcm.js";

/**
 * Playback of the model's 24 kHz audio via ffplay, to the system DEFAULT output device (so set the
 * EMEET as your default output in System Settings → Sound).
 *
 * One ffplay process PER response. When a new response begins (startResponse) we CLOSE the previous
 * player's stdin instead of killing it — so it finishes its buffered audio and exits cleanly via
 * -autoexit. That avoids both failure modes we hit:
 *   - killing it → the previous turn (e.g. "let me check…" before a tool result) gets cut off;
 *   - reusing it → a drained ffplay silently swallows the next reply.
 * Barge-in calls flush(), which SIGKILLs the current player for an instant stop. The EMEET's
 * hardware echo cancellation keeps playback from being heard as user speech.
 */
export class Playback {
  private proc: ChildProcess | null = null;

  start(): void {
    // players are spawned lazily on the first audio chunk of each response
  }

  /** A new response is starting: let the previous player drain + exit, start fresh on next audio. */
  startResponse(): void {
    const prev = this.proc;
    this.proc = null;
    prev?.stdin?.end(); // EOF: ffplay finishes buffered audio, then exits (-autoexit)
  }

  write(samples: Int16Array): void {
    if (samples.length === 0) return;
    const proc = this.proc ?? this.spawn();
    proc.stdin?.write(int16ToBuffer(samples));
  }

  private spawn(): ChildProcess {
    const proc = spawn(
      "ffplay",
      [
        "-hide_banner",
        "-loglevel", "error",
        "-nodisp",
        "-autoexit",
        "-f", "s16le",
        "-ar", String(REALTIME_SAMPLE_RATE),
        "-ch_layout", "mono", // ffplay uses -ch_layout, NOT ffmpeg's -ac
        "-i", "-",
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    log.debug("playback: ffplay started", { pid: proc.pid });
    proc.on("error", (err: Error) => {
      log.error("playback: ffplay failed to start — is ffplay on PATH?", { err: String(err) });
      if (this.proc === proc) this.proc = null;
    });
    proc.on("close", (code) => {
      log.debug("playback: ffplay exited", { code });
      if (this.proc === proc) this.proc = null;
    });
    proc.stderr?.on("data", (d: Buffer) => {
      const msg = d.toString().trim();
      if (/[a-zA-Z]/.test(msg)) log.warn("ffplay stderr", { msg }); // skip bare terminal escape codes
    });
    proc.stdin?.on("error", () => {
      /* ignore EPIPE when we kill mid-write */
    });
    this.proc = proc;
    return proc;
  }

  /** Barge-in: stop playback immediately. */
  flush(): void {
    const proc = this.proc;
    this.proc = null;
    proc?.kill("SIGKILL");
  }

  stop(): void {
    this.flush();
  }
}
