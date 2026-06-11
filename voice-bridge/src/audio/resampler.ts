// Streaming linear-interpolation resampler for int16 mono PCM.
//
// We only ever UPSAMPLE here (16k -> 24k for the uplink, 24k -> 48k for playback), so linear
// interpolation is perfectly adequate for speech and introduces no aliasing (which would only be a
// concern when downsampling). It keeps a fractional read position and the previous chunk's last
// sample across calls so consecutive buffers join seamlessly — important for a continuous stream.
//
// If you ever need high-quality downsampling, swap this for libsamplerate (e.g.
// @alexanderolsen/libsamplerate-js) behind the same process() interface.
export class Resampler {
  private readonly step: number; // input samples advanced per output sample
  private pos = 0; // fractional position within the current input buffer
  private prev = 0; // last input sample of the previous buffer (for index -1)

  constructor(inputRate: number, outputRate: number) {
    if (inputRate <= 0 || outputRate <= 0) throw new Error("resampler rates must be positive");
    this.step = inputRate / outputRate;
  }

  /** Resample one chunk. Pass-through (copy) when input and output rates match. */
  process(input: Int16Array): Int16Array {
    if (this.step === 1) return input.slice();
    if (input.length === 0) return new Int16Array(0);

    const out: number[] = [];
    const at = (i: number): number => (i < 0 ? this.prev : (input[i] ?? input[input.length - 1] ?? 0));

    let t = this.pos;
    while (t < input.length) {
      const i0 = Math.floor(t);
      const frac = t - i0;
      const a = at(i0);
      const b = at(i0 + 1);
      out.push(Math.round(a + (b - a) * frac));
      t += this.step;
    }

    this.pos = t - input.length; // carry the leftover fractional offset into the next buffer
    this.prev = input[input.length - 1] ?? this.prev;
    return Int16Array.from(out);
  }

  /** Clear carried state (call at the start of a new session). */
  reset(): void {
    this.pos = 0;
    this.prev = 0;
  }
}
