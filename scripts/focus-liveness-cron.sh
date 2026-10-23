#!/bin/bash
# focus-liveness — Tier-B freshness engine (churn + migration) for focus markets. DNS-only, rate-exempt.
set -u
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
cd "$HOME/storepulse" || exit 1
node --env-file=.env.local scripts/heartbeat.mjs focus-liveness "starting" >/dev/null 2>&1 || true
echo "===== focus-liveness $(date '+%F %T') ====="
node --env-file=.env.local scripts/focus-liveness.mjs --country ZA,KE,NG --recheck-days 14 --limit 20000 || echo "!! focus-liveness failed"
node --env-file=.env.local scripts/heartbeat.mjs focus-liveness "idle — done" >/dev/null 2>&1 || true
