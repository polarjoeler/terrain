#!/bin/bash
# meta-identify — place country-less published Shopify stores from Shopify's own /meta.json, via the
# Webshare fleet (measured 2026-11-13: ~13/s at concurrency 24, 86-88% placed, ~1% 429). 20k per hourly
# run ≈ 25 min of work; a lock stops overlap if a run is slow. 429 streak / >20% rate ends a run early.
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
LOCK="/tmp/tembo-meta-identify.lock"
if ! mkdir "$LOCK" 2>/dev/null; then echo "meta-identify: previous run still going — skipping"; exit 0; fi
trap 'rmdir "$LOCK"' EXIT
node --env-file=.env.local scripts/heartbeat.mjs meta-identify >/dev/null 2>&1 || true
echo "===== meta-identify $(date '+%F %T') ====="
STORE_PROBE_PROXY_FILE="$HOME/shopify-radar/proxies.txt" node --env-file=.env.local scripts/meta-identify.mjs --limit 20000 --concurrency 24 || echo "!! meta-identify failed"
echo "===== meta-identify done $(date '+%F %T') ====="
