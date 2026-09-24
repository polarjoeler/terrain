#!/bin/bash
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
if ! node --env-file=.env.local scripts/health-check.mjs; then
  echo "[$(date '+%F %T')] HEALTH ALERT (see /ops · Workers · health-check)" >> logs/health-ALERT.log
fi
