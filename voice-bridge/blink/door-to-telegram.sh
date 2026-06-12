#!/usr/bin/env bash
# Snap the Blink doorbell and send the photo to the user's Telegram chat (via the OpenClaw bot).
# Invoked by the OpenClaw "front-door" skill when the user asks to see the front door.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # voice-bridge/
CAMERA="${BLINK_CAMERA:-G8T1-TV02-4302-0FSH}"
CHAT="${BLINK_TELEGRAM_TARGET:-1122461897}"               # the user's Telegram chat id
OUT="$HOME/.openclaw/workspace/jarvis-doorbell/ondemand.jpg"

mkdir -p "$(dirname "$OUT")"
# Fresh snapshot (snap_picture + wait for it to upload).
"$DIR/blink/.venv/bin/python" "$DIR/blink/blink_helper.py" snapshot "$CAMERA" "$OUT" >/dev/null
# Send it to the chat.
openclaw message send --channel telegram --target "$CHAT" \
  --message "🚪 Front door — $(TZ='Europe/Berlin' date '+%d.%m.%Y %H:%M')" \
  --media "$OUT"
rm -f "$OUT"
