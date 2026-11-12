#!/bin/bash
# DNS tech scan — email provider, sending/marketing/support tools, site verifications and hosting for
# every store, from public DNS only (no request reaches a store, so no Shopify budget). Measured
# 2026-11-12 on Rex: 3,000 stores in 55s at concurrency 48. Results go to the store_dns side table.
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
LOCK="/tmp/tembo-dns-tech.lock"
mkdir "$LOCK" 2>/dev/null || { [ -n "$(find "$LOCK" -maxdepth 0 -mmin +120 2>/dev/null)" ] && rmdir "$LOCK" && mkdir "$LOCK"; } || { echo "dns-tech already running"; exit 0; }
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
node --env-file=.env.local scripts/heartbeat.mjs dns-tech >/dev/null 2>&1 || true
echo "===== dns-tech $(date '+%F %T') ====="
node --env-file=.env.local scripts/dns-tech.mjs --limit 60000 --concurrency 48 || echo "!! dns-tech failed (continuing)"
echo "===== dns-tech done $(date '+%F %T') ====="
