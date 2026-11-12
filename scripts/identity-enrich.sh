#!/bin/bash
# Identity enricher — Shopify's own /meta.json record (country, currency, shop id) for Shopify stores
# that have no country, newest finds first. One ~1KB request per store, rotated across the Webshare
# fleet (2026-11-12 dry run: 300 stores, 0 throttled, 73% identified). Stops itself if 429s pass 25%.
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
LOCK="/tmp/tembo-identity-enrich.lock"
mkdir "$LOCK" 2>/dev/null || { [ -n "$(find "$LOCK" -maxdepth 0 -mmin +240 2>/dev/null)" ] && rmdir "$LOCK" && mkdir "$LOCK"; } || { echo "identity-enrich already running"; exit 0; }
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
node --env-file=.env.local scripts/heartbeat.mjs identity >/dev/null 2>&1 || true
echo "===== identity-enrich $(date '+%F %T') ====="
STORE_PROBE_PROXY_FILE="$HOME/shopify-radar/proxies.txt" node --env-file=.env.local scripts/identity-enrich.mjs --limit 6000 --concurrency 12 --pace-ms 500 || echo "!! identity-enrich failed (continuing)"
echo "===== identity-enrich done $(date '+%F %T') ====="
