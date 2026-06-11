# Blink doorbell helper

A small Python sidecar (using the unofficial [blinkpy](https://github.com/fronzbot/blinkpy)) that the
Node bridge shells out to for Blink doorbell snapshots and motion polling.

> **Unofficial API.** blinkpy reverse-engineers Blink's cloud. It's ToS-gray and could break if
> Amazon changes things (it's what Home Assistant uses, so it's widely exercised). It accesses *your*
> account/cameras only. Your Blink password is used once to obtain a token; only the token is stored
> (in `.blink-creds.json`, gitignored).

## One-time setup

The venv + deps are already installed (`.venv/`, blinkpy + aiohttp). Then authenticate:

```bash
cd voice-bridge/blink

# 1) Log in (use YOUR Blink email + password). Enter the 2FA code Blink emails/texts you.
BLINK_EMAIL="you@example.com" BLINK_PASSWORD="your-blink-password" .venv/bin/python blink_helper.py auth

# 2) See your camera names (note the doorbell's exact name)
.venv/bin/python blink_helper.py cameras

# 3) Test a snapshot
.venv/bin/python blink_helper.py snapshot "Front Door" /tmp/door.jpg && open /tmp/door.jpg
```

The password is only needed for step 1; afterwards the token in `.blink-creds.json` is used.

## Commands

| Command | What it does |
|---|---|
| `auth` | One-time login + 2FA, saves the token |
| `cameras` | Print camera names (JSON) |
| `snapshot "<cam>" <path>` | Snap a still and save it |
| `poll "<cam>"` | Print motion/last-record status (for change detection) |

Phase 2 (the Node side: poll → AI-describe → announce over the speaker) wires on top of these.
