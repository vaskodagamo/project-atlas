import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { bufferToInt16 } from "./pcm.js";

/**
 * Continuous microphone capture via ffmpeg's avfoundation input, re-chunked into exact `frameLength`
 * frames. ffmpeg captures the EMEET at its native rate and resamples to `sampleRate` (16 kHz) for
 * us, emitting raw mono PCM16 on stdout. The same frames feed Porcupine (always) and the Realtime
 * uplink (during a session).
 *
 * Emits: "frame" (Int16Array of length frameLength), "error" (Error).
 */
export class Capture extends EventEmitter {
  private proc: ChildProcess | null = null;
  private residual: Buffer = Buffer.alloc(0);
  private readonly frameBytes: number;

  constructor(
    private readonly deviceIndex: number,
    private readonly sampleRate: number,
    private readonly frameLength: number,
  ) {
    super();
    this.frameBytes = frameLength * 2; // int16 => 2 bytes/sample
  }

  start(): void {
    const proc = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel", "error",
        "-f", "avfoundation",
        "-i", `:${this.deviceIndex}`, // ":<audioIndex>" — no video
        "-ac", "1",
        "-ar", String(this.sampleRate),
        "-acodec", "pcm_s16le",
        "-f", "s16le",
        "-",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    proc.stderr.on("data", (b: Buffer) => this.emit("error", new Error(b.toString().trim())));
    proc.on("error", (err: Error) => this.emit("error", err));
    proc.on("close", (code) => {
      if (this.proc && code !== 0 && code !== null) {
        this.emit("error", new Error(`ffmpeg capture exited with code ${code}`));
      }
    });
    this.proc = proc;
  }

  private onData(chunk: Buffer): void {
    this.residual = this.residual.length ? Buffer.concat([this.residual, chunk]) : chunk;
    while (this.residual.length >= this.frameBytes) {
      const slice = this.residual.subarray(0, this.frameBytes);
      this.residual = this.residual.subarray(this.frameBytes);
      this.emit("frame", bufferToInt16(slice));
    }
  }

  stop(): void {
    const proc = this.proc;
    this.proc = null;
    proc?.kill("SIGKILL");
    this.residual = Buffer.alloc(0);
  }
}

export interface Capture {
  on(event: "frame", listener: (frame: Int16Array) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  emit(event: "frame", frame: Int16Array): boolean;
  emit(event: "error", err: Error): boolean;
}
