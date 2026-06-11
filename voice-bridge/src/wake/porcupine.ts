import { Porcupine, BuiltinKeyword } from "@picovoice/porcupine-node";

/**
 * Local "Hey Jarvis" wake-word detection. Porcupine ships a built-in JARVIS keyword and runs fully
 * on-device (no cloud, no audio leaves the machine until the wake word fires). It requires 16 kHz
 * mono int16 frames of exactly `frameLength` samples.
 */
export class WakeWord {
  private readonly porcupine: Porcupine;

  constructor(accessKey: string, sensitivity = 0.5) {
    this.porcupine = new Porcupine(accessKey, [BuiltinKeyword.JARVIS], [sensitivity]);
  }

  /** Samples per frame Porcupine expects (typically 512). */
  get frameLength(): number {
    return this.porcupine.frameLength;
  }

  /** Sample rate Porcupine expects (16000). */
  get sampleRate(): number {
    return this.porcupine.sampleRate;
  }

  /** Returns true if the wake word was detected in this frame. */
  process(frame: Int16Array): boolean {
    return this.porcupine.process(frame) >= 0;
  }

  release(): void {
    this.porcupine.release();
  }
}
