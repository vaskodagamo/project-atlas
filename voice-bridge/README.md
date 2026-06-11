# voice-bridge

The Node/TypeScript service that gives Project Atlas its voice: **"Hey Jarvis" → OpenAI Realtime
(`gpt-realtime-2`) speech-to-speech → EMEET 360**, with **OpenClaw** as the memory/tool backbone.

See [../CLAUDE.md](../CLAUDE.md) for the architecture. This README is the setup runbook.

## Prerequisites

1. **ffmpeg** (provides `ffmpeg` for capture and `ffplay` for playback — no native build needed):
   `brew install ffmpeg`
2. **Node 22.19+** (Node 23 is fine) and npm.
3. **EMEET 360** plugged in. Open **System Settings → Sound** and:
   - confirm it appears as an **input** device, and
   - set it as your **default output** device (playback uses the system default).
4. **OpenAI API key** with Realtime access (`gpt-realtime-2`).
5. *(Optional)* **Picovoice access key** from <https://console.picovoice.ai> — only for the
   hands-free "Hey Jarvis" wake word (`WAKE_MODE=porcupine`). The default `WAKE_MODE=ptt`
   (push-to-talk) needs no account.
6. **OpenClaw** installed and running (the backbone — memory now, actions later):
   ```bash
   npm i -g openclaw@latest
   openclaw onboard --install-daemon
   ```
   The bridge talks to it via the **`openclaw agent` CLI** (no HTTP wiring needed) — just make sure
   a model provider is configured during onboarding and the gateway daemon ends up running.

## Configure

```bash
cd voice-bridge
cp .env.example .env
```
Fill in `.env`:
- `OPENAI_API_KEY`
- `WAKE_MODE` — `ptt` (push-to-talk, default, no account) or `porcupine` (then set `PICOVOICE_ACCESS_KEY`)
- `OPENCLAW_AGENT` (default `main`) and `OPENCLAW_BIN` (default `openclaw`; for the launchd service
  set the absolute path from `which openclaw`)
- `EMEET_DEVICE_NAME` — usually `EMEET`; confirm with `npm run list-devices`.
- Smoke-test the backbone any time with `npm run test:openclaw`.

## Install + run

```bash
npm install            # pure JS deps — no native compilation
npm run list-devices   # confirm the EMEET shows up as a capture device
npm start              # FIRST run: approve the macOS microphone prompt
```
**Push-to-talk (default):** press **Enter** (or space), say something, and Jarvis replies; press
Enter again to end the conversation. (With `WAKE_MODE=porcupine` you'd just say "Hey Jarvis" instead.)
You should hear a spoken reply within ~a second of finishing your sentence.

> **First-run microphone permission is load-bearing.** macOS will prompt to allow the mic the first
> time you run from Terminal. You must approve it here — a launchd service can't show that dialog,
> so if you install the boot service before granting permission, capture silently returns zeros.

## Run on boot (after the first manual run works)

```bash
ops/install-service.sh           # installs a launchd user agent, starts it
launchctl kickstart -k gui/$(id -u)/com.jarvis.voicebridge   # restart
ops/uninstall-service.sh         # remove
```
Logs: `~/Library/Logs/jarvis/voicebridge.{out,err}.log`.

## v1 verification checklist

1. **EMEET selected** — `npm run list-devices` lists it; startup logs `audio input resolved`.
2. **Mic capturing** — startup logs `microphone capturing` with a non-zero `rmsLevel` while you
   speak. Zero ⇒ mic permission not granted to `node`.
3. **Turn starts** — press Enter/space (push-to-talk) and the logs show `opening Realtime session`
   → `session ready — go ahead and talk`. (With `WAKE_MODE=porcupine`, saying "Hey Jarvis" does this.)
4. **Sub-second reply** — ask "what's two plus two"; you hear the answer quickly. The logs show the
   `response` events between your turn ending and audio playing.
5. **Barge-in** — talk over Jarvis mid-answer; playback stops within ~100–200 ms (`speech_started`).
6. **Memory persists** — say "remember my office is room 204" (routes through the `ask_openclaw`
   tool → OpenClaw), restart, then ask "what's my office number". It should recall. Verify the
   backbone directly with `npm run test:openclaw -- "what is my office number?"`.

> **Push-to-talk needs a terminal (TTY).** It's for `npm start` runs. The launchd boot service has no
> keyboard — use `WAKE_MODE=porcupine` (or another wake-word mode) for always-on hands-free operation.

## Troubleshooting

- **`ffmpeg`/`ffplay` not found** — `brew install ffmpeg`.
- **No EMEET found** — re-plug it, check `npm run list-devices`, fix `EMEET_DEVICE_NAME`.
- **`rmsLevel` is 0 / no audio captured** — microphone permission. macOS attributes mic access to
  the app that launched ffmpeg (Terminal on a manual run). Grant it in
  System Settings → Privacy & Security → Microphone, then re-run `npm start`. A launchd service
  can't show this prompt, so always do the first run manually.
- **No sound on replies** — make sure the EMEET is the **default output** device (Sound settings);
  ffplay plays to the default output.
- **`OpenClaw gateway not reachable`** — start the daemon (`openclaw onboard --install-daemon`),
  verify `OPENCLAW_URL`/token. Conversation still works; only memory/tools need it.

## Layout

```
src/
  index.ts            entrypoint + IDLE→SESSION state machine
  config.ts           zod-validated env
  logger.ts           leveled stdout logging
  audio/
    devices.ts        EMEET capture-device resolution (ffmpeg avfoundation enumeration)
    capture.ts        ffmpeg 16 kHz mic capture, re-chunked into Porcupine frames
    playback.ts       ffplay playback to default output; kill-on-flush for barge-in
    resampler.ts      streaming linear upsampler (16→24 for the uplink)
    pcm.ts            int16/Buffer/base64 helpers
    list-devices.ts   `npm run list-devices`
  wake/porcupine.ts   "Hey Jarvis" wake word (local)
  realtime/
    client.ts         OpenAI Realtime WebSocket client
    session.ts        session.update config (persona, audio formats, tools)
  tools/
    dispatcher.ts     tool registry + dispatch (requiresConfirmation flag for later)
    openclaw.ts       HTTP client to the OpenClaw gateway
ops/                  launchd agent + install/uninstall scripts
```
