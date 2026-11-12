#!/bin/bash
# Priority score — one size score per store (traffic, followers, team size, Plus, revenue, growth,
# rolled up across store groups) in store_priority; the payments queue, the contact lanes and the
# render lane all order by it. DB-only: no crawling, ~1 minute.
#   Driven by ~/Library/LaunchAgents/com.tembo.build-priority.plist (daily 19:30 Rex time = 05:30 SAST,
#   before the morning digest).
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

node --env-file=.env.local scripts/heartbeat.mjs build-priority "rebuilding" >/dev/null 2>&1 || true
echo "===== build-priority $(date '+%F %T') ====="

node --no-warnings --env-file=.env.local scripts/build-priority.mjs --show ZA || echo "!! build-priority failed"

node --env-file=.env.local scripts/heartbeat.mjs build-priority "idle — done" >/dev/null 2>&1 || true
echo "===== build-priority done $(date '+%T') ====="
