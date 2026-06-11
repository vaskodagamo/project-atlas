#!/usr/bin/env bash
# Install the voice-bridge as a launchd user agent so it runs on login and restarts on crash.
#
# IMPORTANT (Apple Silicon mic-permission trap): a launchd process can't show the microphone
# permission dialog. Run `npm start` from Terminal at least once and approve the prompt BEFORE
# installing this service, or audio capture will silently return zeros.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="$(command -v node)"
TSX="$DIR/node_modules/.bin/tsx"
ENTRY="$DIR/src/index.ts"
LOGDIR="$HOME/Library/Logs/jarvis"
LABEL="com.jarvis.voicebridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"

[ -n "$NODE" ] || { echo "node not found on PATH"; exit 1; }
[ -x "$TSX" ] || { echo "tsx not found at $TSX — run 'npm install' first"; exit 1; }
[ -f "$DIR/.env" ] || echo "warning: $DIR/.env not found — the service will fail config validation"

mkdir -p "$LOGDIR" "$HOME/Library/LaunchAgents"

NODEBIN="$(dirname "$NODE")"  # holds node + the global `openclaw` CLI (same nvm/bin dir)

sed -e "s|@@NODE@@|$NODE|g" \
    -e "s|@@TSX@@|$TSX|g" \
    -e "s|@@ENTRY@@|$ENTRY|g" \
    -e "s|@@DIR@@|$DIR|g" \
    -e "s|@@LOGDIR@@|$LOGDIR|g" \
    -e "s|@@NODEBIN@@|$NODEBIN|g" \
    "$DIR/ops/$LABEL.plist" > "$PLIST"

launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
launchctl enable "gui/$UID_NUM/$LABEL"

echo "Installed $LABEL and started it."
echo "Logs:    $LOGDIR/voicebridge.{out,err}.log"
echo "Restart: launchctl kickstart -k gui/$UID_NUM/$LABEL"
echo "Stop:    ops/uninstall-service.sh"
