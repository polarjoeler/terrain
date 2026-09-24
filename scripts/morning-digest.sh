#!/bin/bash
# Private morning ops digest → owner's inbox. Driven by com.tembo.morning-digest.plist (07:00 SAST).
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
mkdir -p logs
echo "===== morning-digest $(date '+%F %T') ====="
node --env-file=.env.local scripts/morning-digest.mjs 2>&1
echo "===== done $(date '+%T') ====="
