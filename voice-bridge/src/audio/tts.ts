import { config, REALTIME_SAMPLE_RATE } from "../config.js";
import { log } from "../logger.js";
import { bufferToInt16 } from "./pcm.js";
import type { Playback } from "./playback.js";

// Speak a one-off line (doorbell announcements, etc.) without opening a Realtime session: synthesize
// with OpenAI's TTS endpoint (24 kHz PCM, matching our playback) and push it through the same
// sequential Playback queue, so it never overlaps a reply that's mid-sentence.
export async function speak(text: string, playback: Playback): Promise<void> {
  if (!text.trim()) return;
  try {
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.announce.ttsModel,
        voice: config.openai.voice,
        input: text,
        response_format: "pcm", // raw 24 kHz mono s16le
      }),
    });
    if (!res.ok) {
      log.error("tts request failed", { status: res.status, body: (await res.text().catch(() => "")).slice(0, 200) });
      return;
    }
    const pcm = Buffer.from(await res.arrayBuffer());
    if (pcm.length === 0) return;
    void REALTIME_SAMPLE_RATE; // (the TTS pcm format is already 24 kHz to match playback)
    playback.startResponse();
    playback.write(bufferToInt16(pcm));
    playback.finishResponse();
  } catch (err) {
    log.error("tts error", { err: String(err) });
  }
}
