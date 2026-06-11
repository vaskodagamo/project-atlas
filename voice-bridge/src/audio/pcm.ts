// Helpers for moving between Node Buffers (raw interleaved int16 LE, as produced/consumed by
// PortAudio) and Int16Array / base64 (as the Realtime API wants).

/** Copy a Buffer of little-endian int16 samples into an Int16Array (alignment-safe). */
export function bufferToInt16(buf: Buffer): Int16Array {
  const out = new Int16Array(buf.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

/** Pack an Int16Array into a little-endian Buffer. */
export function int16ToBuffer(arr: Int16Array): Buffer {
  const buf = Buffer.allocUnsafe(arr.length * 2);
  for (let i = 0; i < arr.length; i++) buf.writeInt16LE(arr[i] ?? 0, i * 2);
  return buf;
}

export function int16ToBase64(arr: Int16Array): string {
  return int16ToBuffer(arr).toString("base64");
}

export function base64ToInt16(b64: string): Int16Array {
  return bufferToInt16(Buffer.from(b64, "base64"));
}

/** Root-mean-square amplitude (0..32768) — handy for confirming the mic is actually capturing. */
export function rms(arr: Int16Array): number {
  if (arr.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    const s = arr[i] ?? 0;
    sum += s * s;
  }
  return Math.sqrt(sum / arr.length);
}
