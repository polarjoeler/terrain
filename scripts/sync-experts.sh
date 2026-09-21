#!/bin/bash
# Daily sync of Africa Shop Experts (Fundi) → Terrain's service_partners table.
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
node --env-file=.env.local scripts/heartbeat.mjs sync-experts "pull experts" >/dev/null 2>&1 || true
echo "===== sync-experts $(date '+%F %T') ====="
node --env-file=.env.local scripts/sync-experts.mjs || echo "!! sync-experts failed"
echo "===== done $(date '+%T') ====="
