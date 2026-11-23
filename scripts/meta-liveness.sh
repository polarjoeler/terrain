#!/bin/bash
# meta-liveness — /meta.json liveness for every customer-visible African Shopify store, via the
# Webshare fleet (never the home IP). 1,000 per run every 4h ≈ 6k/day, so the ~74k visible stores
# come round in ~12-13 days against a 14-day cycle. Measured 2026-11-24 dry-run: ~5.8/s at conc 12,
# 0.4% 429. Own lock: it shares the proxy pool with meta-identify but not its queue.
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
LOCK="/tmp/tembo-meta-liveness.lock"
if ! mkdir "$LOCK" 2>/dev/null; then echo "meta-liveness: previous run still going — skipping"; exit 0; fi
trap 'rmdir "$LOCK"' EXIT
node --env-file=.env.local scripts/heartbeat.mjs meta-liveness >/dev/null 2>&1 || true
echo "===== meta-liveness $(date '+%F %T') ====="
STORE_PROBE_PROXY_FILE="$HOME/shopify-radar/proxies.txt" node --env-file=.env.local scripts/meta-liveness.mjs --limit 1000 --concurrency 12 || echo "!! meta-liveness failed"
echo "===== meta-liveness done $(date '+%F %T') ====="
