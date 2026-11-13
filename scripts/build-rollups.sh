#!/bin/bash
# Summary tables — store_rollup (hourly backlog/coverage/freshness by country × platform) and
# metrics_daily (one row per SAST day; the first run after 00:00 SAST closes the day that ended).
# Reads only the slim store_work table. DB-only, ~1 minute.
#   Driven by ~/Library/LaunchAgents/com.tembo.build-rollups.plist (every hour at :05).
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

node --env-file=.env.local scripts/heartbeat.mjs build-rollups "rebuilding" >/dev/null 2>&1 || true
echo "===== build-rollups $(date '+%F %T') ====="
node --no-warnings --env-file=.env.local scripts/build-rollups.mjs || echo "!! build-rollups failed"
node --env-file=.env.local scripts/heartbeat.mjs build-rollups "idle — done" >/dev/null 2>&1 || true
echo "===== build-rollups done $(date '+%T') ====="
