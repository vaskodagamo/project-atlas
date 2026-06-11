import { spawn, type ChildProcess } from "node:child_process";
import { REALTIME_SAMPLE_RATE } from "../config.js";
import { log } from "../logger.js";
import { int16ToBuffer } from "./pcm.js";

/**
 * Playback of the model's 24 kHz audio via ffplay, to the system DEFAULT output device — so set the
 * EMEET 360 as your default output (System Settings → Sound). (ffplay uses SDL and can't target a
 * named CoreAudio device, unlike capture.)
 *
 * The ffplay process is spawned lazily on the first audio of a turn and kept warm across turns, so
 * normal replies have no spawn latency. On barge-in we `flush()`, which KILLS ffplay — the fastest
 * possible way to stop Jarvis mid-sentence. The next reply respawns it (a one-time ~100 ms cost paid
 * only after an interruption). The EMEET's hardware echo cancellation keeps playback from being
 * picked up as user speech.
 */
export class Playback {
  private proc: ChildProcess | null = null;

  start(): void {
    // ffplay is spawned lazily on first write; nothing to do here.
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
    log.info("playback: ffplay started", { pid: proc.pid });
    proc.on("error", (err: Error) => {
      log.error("playback: ffplay failed to start — is ffplay on PATH?", { err: String(err) });
      if (this.proc === proc) this.proc = null;
    });
    proc.on("close", (code) => {
      log.debug("playback: ffplay exited", { code });
      if (this.proc === proc) this.proc = null;
    });
    proc.stderr?.on("data", (d: Buffer) => log.warn("ffplay stderr", { msg: d.toString().trim() }));
    proc.stdin?.on("error", () => {
      /* ignore EPIPE when we kill mid-write */
    });
    this.proc = proc;
    return proc;
  }

  /** Barge-in: stop playback immediately by killing ffplay. */
  flush(): void {
    const proc = this.proc;
    this.proc = null;
    proc?.kill("SIGKILL");
  }

  stop(): void {
    this.flush();
  }
}
