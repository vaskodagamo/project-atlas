import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { REALTIME_SAMPLE_RATE } from "../config.js";
import { log } from "../logger.js";
import { int16ToBuffer } from "./pcm.js";

interface Utterance {
  chunks: Buffer[];
  complete: boolean;
}

// A short lead of silence written to each fresh ffplay. ffplay clips ~150ms while its audio device
// starts up, which would otherwise eat the first syllable — let it clip the silence instead.
const LEAD_SILENCE_MS = 250;
const LEAD_SILENCE = Buffer.alloc(Math.round((REALTIME_SAMPLE_RATE * LEAD_SILENCE_MS) / 1000) * 2);

/**
 * Sequential playback of the model's 24 kHz audio via ffplay, to the system DEFAULT output device
 * (set the EMEET as your default output in System Settings → Sound).
 *
 * Each response is one queued "utterance". Only ONE ffplay runs at a time: a new response's audio
 * waits in the queue until the previous response has FULLY played out, then plays on its own fresh
 * ffplay. This guarantees replies play strictly one-by-one (never two voices at once) and that a
 * reply is never cut off mid-sentence. Barge-in (flush) drops the whole queue and kills the player
 * instantly. The EMEET's hardware echo cancellation keeps playback out of the mic.
 *
 * Events: "playing" (went from idle to playing), "drained" (queue fully played out → safe to idle).
 */
export class Playback extends EventEmitter {
  private queue: Utterance[] = [];
  private proc: ChildProcess | null = null;
  private writeIndex = 0; // chunks of the head utterance already written to its ffplay
  private active = false;

  start(): void {
    // players are spawned lazily as utterances reach the head of the queue
  }

  /** A new response begins — its audio queues behind anything still playing. */
  startResponse(): void {
    this.queue.push({ chunks: [], complete: false });
    this.pump();
  }

  write(samples: Int16Array): void {
    if (samples.length === 0) return;
    let utt = this.queue[this.queue.length - 1];
    if (!utt) {
      utt = { chunks: [], complete: false };
      this.queue.push(utt);
    }
    utt.chunks.push(int16ToBuffer(samples));
    this.pump();
  }

  /** The current response's audio is complete (no more chunks coming for it). */
  finishResponse(): void {
    const utt = this.queue[this.queue.length - 1];
    if (utt) utt.complete = true;
    this.pump();
  }

  private pump(): void {
    // Discard completed, silent utterances at the head (e.g. tool-only / text-only responses).
    while (!this.proc) {
      const h = this.queue[0];
      if (h && h.complete && h.chunks.length === 0) this.queue.shift();
      else break;
    }

    const head = this.queue[0];
    if (!head) {
      this.maybeDrained();
      return;
    }

    if (!this.proc) {
      this.writeIndex = 0;
      this.proc = this.spawn();
      this.proc.stdin?.write(LEAD_SILENCE); // absorb ffplay's startup clipping so the first word isn't cut
      if (!this.active) {
        this.active = true;
        this.emit("playing");
      }
    }

    while (this.writeIndex < head.chunks.length) {
      const chunk = head.chunks[this.writeIndex];
      if (chunk) this.proc.stdin?.write(chunk);
      this.writeIndex++;
    }

    if (head.complete && this.writeIndex >= head.chunks.length) {
      this.proc.stdin?.end(); // EOF -> ffplay finishes buffered audio, then exits (-autoexit)
    }
  }

  private onPlayerExit(proc: ChildProcess): void {
    if (this.proc !== proc) return;
    this.proc = null;
    this.queue.shift(); // the head finished playing
    if (this.queue.length > 0) this.pump();
    else this.maybeDrained();
  }

  private maybeDrained(): void {
    if (this.active && !this.proc && this.queue.length === 0) {
      this.active = false;
      this.emit("drained");
    }
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
      this.onPlayerExit(proc);
    });
    proc.on("close", () => this.onPlayerExit(proc));
    proc.stderr?.on("data", (d: Buffer) => {
      const msg = d.toString().trim();
      if (/[a-zA-Z]/.test(msg)) log.warn("ffplay stderr", { msg }); // skip bare terminal escape codes
    });
    proc.stdin?.on("error", () => {
      /* ignore EPIPE when we end/kill mid-write */
    });
    return proc;
  }

  /** Barge-in: drop the whole queue and stop instantly (no "drained"). */
  flush(): void {
    this.queue = [];
    this.writeIndex = 0;
    this.active = false;
    const proc = this.proc;
    this.proc = null;
    proc?.kill("SIGKILL");
  }

  stop(): void {
    this.flush();
  }
}

export interface Playback {
  on(event: "playing" | "drained", listener: () => void): this;
  emit(event: "playing" | "drained"): boolean;
}
