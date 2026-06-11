#!/usr/bin/env bash
set -euo pipefail
LABEL="com.jarvis.voicebridge"
UID_NUM="$(id -u)"
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "Removed $LABEL."
