import { config, REALTIME_SAMPLE_RATE } from "./config.js";
import { log } from "./logger.js";
import { WakeWord } from "./wake/porcupine.js";
import { PushToTalk } from "./wake/pushtotalk.js";
import { findEmeetInput } from "./audio/devices.js";
import { Capture } from "./audio/capture.js";
import { Playback } from "./audio/playback.js";
import { Resampler } from "./audio/resampler.js";
import { RealtimeClient, type FunctionCall } from "./realtime/client.js";
import { dispatch } from "./tools/dispatcher.js";
import { pingOpenclaw } from "./tools/openclaw.js";
import { whatsapp } from "./tools/whatsapp.js";
import { startDoorbellWatcher } from "./tools/blink.js";
import { speak } from "./audio/tts.js";
import { rms } from "./audio/pcm.js";

const mode = config.wake.mode; // "ptt" | "porcupine"
const idleHint = mode === "porcupine" ? 'say "Hey Jarvis"' : "press Enter/space to talk";

// ── wake mechanism (pluggable) ────────────────────────────────────────────────
let wake: WakeWord | null = null;
let ptt: PushToTalk | null = null;

if (mode === "porcupine") {
  if (!config.picovoice.accessKey) {
    log.error("WAKE_MODE=porcupine requires PICOVOICE_ACCESS_KEY in .env");
    process.exit(1);
  }
  wake = new WakeWord(config.picovoice.accessKey, config.picovoice.sensitivity);
  log.info("wake mode: porcupine 'Hey Jarvis'", { frameLength: wake.frameLength, sampleRate: wake.sampleRate });
  if (config.audio.captureSampleRate !== wake.sampleRate) {
    log.error("CAPTURE_SAMPLE_RATE must equal the wake-word sample rate", {
      capture: config.audio.captureSampleRate,
      required: wake.sampleRate,
    });
    process.exit(1);
  }
} else {
  ptt = new PushToTalk();
  log.info("wake mode: push-to-talk (Enter/space toggles a conversation; Ctrl-C quits)");
}

// Porcupine needs exact frames of its frameLength; push-to-talk just needs a steady chunk size.
const frameLength = wake ? wake.frameLength : 512;

// ── audio devices ─────────────────────────────────────────────────────────────
// Capture is a named device (the EMEET); playback goes to the system DEFAULT output (set the EMEET
// as default in Sound settings). ffplay handles the 24k -> device-rate conversion, so there is no
// downlink resampler here — we feed it the model's 24 kHz audio directly.
const input = findEmeetInput(config.audio.deviceName);
log.info("audio input resolved", { input: `[${input.index}] ${input.name}` });

const capture = new Capture(input.index, config.audio.captureSampleRate, frameLength);
const playback = new Playback();
const uplink = new Resampler(config.audio.captureSampleRate, REALTIME_SAMPLE_RATE); // 16k -> 24k

// ── conversation state machine ────────────────────────────────────────────────
type State = "IDLE" | "SESSION";
let state: State = "IDLE";
let rt: RealtimeClient | null = null;
let inactivity: NodeJS.Timeout | null = null;
let playbackActive = false; // Jarvis is currently speaking (ffplay playing out a reply)
let toolRunning = false; // a tool call is in flight
// Mic sanity check: track the peak level over the first ~3s so a dead/permission-blocked mic is obvious.
let micCheckFrames = 0;
let micPeak = 0;
const MIC_CHECK_FRAMES = Math.round(3000 / ((frameLength / config.audio.captureSampleRate) * 1000));

// Only count down to idle when nothing is happening — not while Jarvis is still talking out a reply
// or a tool call is running. (Fixes a reply getting cut off when the session went idle mid-playback.)
function refreshIdle(): void {
  if (inactivity) {
    clearTimeout(inactivity);
    inactivity = null;
  }
  if (state === "SESSION" && !playbackActive && !toolRunning) {
    inactivity = setTimeout(endSession, config.session.inactivityMs);
  }
}

// Playback lifecycle drives the idle timer (registered once; playback is a singleton).
playback.on("playing", () => {
  playbackActive = true;
  refreshIdle();
});
playback.on("drained", () => {
  playbackActive = false;
  refreshIdle();
});

async function startSession(): Promise<void> {
  if (state === "SESSION") return;
  state = "SESSION"; // set synchronously so incoming frames route to the (not-yet-ready) session
  uplink.reset();
  log.info("opening Realtime session");

  const client = new RealtimeClient();
  rt = client;

  client.on("audio", (pcm: Int16Array) => playback.write(pcm));
  client.on("speech_started", () => {
    log.info("heard you — listening");
    playback.flush(); // stop talking the instant the user does; server_vad cancels the response
    playbackActive = false;
    refreshIdle();
  });
  client.on("response_started", () => {
    log.info("Jarvis is replying");
    playback.startResponse(); // fresh ffplay for this response (fixes post-tool reply being silent)
  });
  client.on("assistant_done", () => playback.finishResponse()); // drain → "drained" arms the idle timer
  client.on("function_call", async (call: FunctionCall) => {
    log.info("tool call", { name: call.name, args: call.args });
    toolRunning = true;
    refreshIdle();
    const result = await dispatch(call.name, call.args);
    log.debug("tool result", { name: call.name, result: result.slice(0, 200) });
    client.sendFunctionResult(call.callId, result);
    toolRunning = false;
    refreshIdle();
  });
  client.on("error", (err: Error) => log.error("realtime error", { err: String(err) }));
  client.on("close", () => {
    if (rt === client) endSession();
  });

  try {
    await client.connect();
    log.info("session ready — go ahead and talk");
    refreshIdle();
  } catch (err) {
    log.error("failed to open Realtime session", { err: String(err) });
    endSession();
  }
}

function endSession(): void {
  if (state === "IDLE") return;
  if (inactivity) {
    clearTimeout(inactivity);
    inactivity = null;
  }
  playbackActive = false;
  toolRunning = false;
  playback.flush();
  rt?.close();
  rt = null;
  state = "IDLE";
  log.info(`back to idle — ${idleHint}`);
}

// ── push-to-talk toggle (when enabled) ────────────────────────────────────────
if (ptt) {
  ptt.on("toggle", () => {
    if (state === "IDLE") startSession().catch((e) => log.error("startSession error", { err: String(e) }));
    else endSession();
  });
}

// ── audio in: wake detection (porcupine) while idle, uplink while in a session ──
capture.on("frame", (frame: Int16Array) => {
  if (micCheckFrames < MIC_CHECK_FRAMES) {
    micPeak = Math.max(micPeak, rms(frame));
    if (++micCheckFrames === MIC_CHECK_FRAMES) {
      log.info("microphone level (peak over first 3s)", { peak: Math.round(micPeak) });
      if (micPeak < 5) {
        log.warn(
          "mic level looks dead (near zero). If you spoke just now and Jarvis can't hear you, grant " +
            "Microphone permission to your terminal in System Settings → Privacy & Security → Microphone. " +
            "(Harmless if you were silent at startup — the real test is the 'heard you' log.)",
        );
      }
    }
  }
  if (state === "IDLE") {
    if (wake?.process(frame)) {
      startSession().catch((e) => log.error("startSession error", { err: String(e) }));
    }
  } else if (rt?.ready) {
    rt.appendAudio(uplink.process(frame));
  }
});
capture.on("error", (err: Error) => log.error("capture error", { err: String(err) }));

// ── startup ───────────────────────────────────────────────────────────────────
if (await pingOpenclaw()) {
  log.info("OpenClaw gateway reachable", { url: config.openclaw.url });
} else {
  log.warn("OpenClaw gateway not reachable — memory/tools will fail until it's up", {
    url: config.openclaw.url,
  });
}

if (config.whatsapp.enabled) {
  log.info("connecting WhatsApp (first run prints a QR to scan from your phone)…");
  whatsapp.start().catch((e) => log.error("WhatsApp start failed", { err: String(e) }));
}

if (config.blink.enabled) {
  startDoorbellWatcher(async (text) => {
    log.info("doorbell announcement", { text });
    await speak(text, playback); // proactive: speak even with no active session
  });
}

playback.start();
capture.start();
ptt?.start();
log.info(`Jarvis online — ${idleHint}.`);

// ── graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(sig: string): void {
  log.info("shutting down", { sig });
  try {
    endSession();
  } catch {
    /* ignore */
  }
  try {
    capture.stop();
  } catch {
    /* ignore */
  }
  try {
    playback.stop();
  } catch {
    /* ignore */
  }
  try {
    ptt?.stop();
  } catch {
    /* ignore */
  }
  try {
    wake?.release();
  } catch {
    /* ignore */
  }
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
