# Project Atlas — local "Jarvis" voice assistant

A self-hosted voice assistant for a **Mac Mini M1**. You say **"Hey Jarvis"** into an
**EMEET 360 USB speakerphone** and get a low-latency spoken reply. Over time it gains the
ability to *act* (Gmail, Mac control, Docker, Home Assistant).

## Architecture: brain vs. backbone

```
 "Hey Jarvis"            EMEET 360 (USB, on-device echo cancellation)
       │                   ▲  mic 16k        ▼ speaker 48k
       ▼                   │                 │
 ┌──────────────── voice-bridge/ (Node + TypeScript) ─────────────────┐
 │  Porcupine wake word → OpenAI Realtime WS (gpt-realtime-2)          │
 │  EMEET audio I/O + resampling + barge-in                           │
 │  tool dispatcher ───────────────────────────┐                      │
 └──────────────────────────────────────────────┼──────────────────────┘
                                   `openclaw agent --json` ▼ (CLI → gateway)
                              OpenClaw gateway daemon (Node, launchd, :18789)
                              ├─ memory: SQLite + MEMORY.md
                              └─ tools/skills/MCP: Gmail · Mac · Docker · HA (LATER)
```

- **OpenAI `gpt-realtime-2`** is the *brain* — it listens, reasons, speaks, and decides when to
  call a tool. Speech-to-speech over a WebSocket, sub-second turns, native barge-in.
- **OpenClaw** (self-hosted Node agent daemon, formerly Moltbot/Clawdbot) is the *backbone* —
  persistent memory (SQLite + `MEMORY.md`) now, and the host for real actions (Gmail, Mac, Docker,
  Home Assistant) later. Everything the assistant *remembers* or *does* routes here over HTTP.
- **EMEET 360** is a normal CoreAudio in/out device with hardware AEC (critical for barge-in).

Why this split: OpenClaw's *own* Mac voice mode is a slow STT→LLM→TTS chain (~2–5s). We keep the
voice loop custom for low latency and let OpenClaw own memory + actions. One runtime (Node) end to end.

## Layout

```
project-atlas/
├── CLAUDE.md            ← you are here
└── voice-bridge/        ← the Node/TS service (the only code we build)
    ├── src/
    │   ├── index.ts             entrypoint + IDLE→SESSION state machine
    │   ├── config.ts            zod-validated env
    │   ├── logger.ts            leveled stdout logging
    │   ├── audio/               EMEET capture (ffmpeg) + playback (ffplay), resampling, pcm utils
    │   ├── wake/porcupine.ts    "Hey Jarvis" wake word (local)
    │   ├── realtime/            OpenAI Realtime WS client + session config
    │   └── tools/               dispatcher + OpenClaw HTTP client
    └── ops/                     launchd agent + install script
```

## Current status (v1)

**Goal of v1:** low-latency spoken conversation + persistent memory. No integrations yet — but a
single stub tool (`ask_openclaw`) proves the Realtime→tool→OpenClaw→speech loop and memory
persistence end to end. Gmail is the first real integration after v1 is solid.

## Run it

See [voice-bridge/README.md](voice-bridge/README.md) for full setup. Short version:

```bash
brew install ffmpeg           # capture (ffmpeg) + playback (ffplay); no native build
cd voice-bridge
cp .env.example .env          # fill in OPENAI_API_KEY, PICOVOICE_ACCESS_KEY, OPENCLAW_*
npm install
npm run list-devices          # confirm the EMEET shows up; note its name
npm start                     # push-to-talk (default): press Enter/space to talk
```

## Conventions / things to know

- **TypeScript, ESM, run via `tsx`** (dev and prod). No build step required.
- **Audio backend is ffmpeg/ffplay** (no native modules). Capture is the named EMEET device via
  ffmpeg; playback is the system **default output** via ffplay — so set the EMEET as default output.
- **Audio rates:** capture at 16 kHz mono (Porcupine's native rate, also feeds the model after a
  16→24 kHz upsample); Realtime audio is 24 kHz PCM16; ffplay handles the device-rate conversion.
- **Barge-in** kills the ffplay process (fast stop). The EMEET's hardware echo cancellation keeps
  playback from being picked up as user speech — so keep the EMEET as both mic and speaker.
- **Microphone permission trap (Apple Silicon):** a launchd process can't show the mic-permission
  dialog. Run `npm start` from Terminal once and approve the prompt *before* enabling the boot
  agent, or capture silently returns zeros.
- **Wake is pluggable via `WAKE_MODE`:** `ptt` (push-to-talk, default — Enter/space toggles a turn,
  terminal only, no account) or `porcupine` ("Hey Jarvis", needs a Picovoice key, works under launchd).
  Push-to-talk needs a TTY, so the boot service must use a wake-word mode.
- **Memory lives in OpenClaw**, not here. The bridge is stateless except for per-session state.
  The bridge reaches it by shelling out to `openclaw agent --json` (the gateway HTTP port is the
  Control UI, not an OpenAI-compatible API).
- **Tools can be backed by OpenClaw or by local code.** Currently: memory → OpenClaw; **work email
  (IMAP) and Mac control live locally in `src/tools/`** (lower latency, full control). Each capability
  is gated by an env flag (`IMAP_*`, `MAC_CONTROL`) so it only loads when configured.
- **Destructive tools** set `requiresConfirmation`; the dispatcher *stages* them and runs them only
  after a spoken "confirm" (via the `confirm_action` tool). Mac `run_shell` / `run_applescript` use
  this — they never execute on the first call.

The full implementation plan is at
`~/.claude/plans/build-me-a-local-rippling-peach.md`.
