#!/bin/bash
# Store groups — rebuild who-runs-which-stores (store_groups / store_group_members) from data we
# already hold. DB-only: no crawling, so no Shopify-edge budget; ~15s per run.
#   Driven by ~/Library/LaunchAgents/com.tembo.store-groups.plist (daily).
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

node --env-file=.env.local scripts/heartbeat.mjs store-groups "rebuilding" >/dev/null 2>&1 || true
echo "===== store-groups $(date '+%F %T') ====="

node --env-file=.env.local scripts/build-store-groups.mjs --countries ZA,KE,NG || echo "!! build-store-groups failed"

node --env-file=.env.local scripts/heartbeat.mjs store-groups "idle — done" >/dev/null 2>&1 || true
echo "===== store-groups done $(date '+%T') ====="
