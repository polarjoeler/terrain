#!/bin/bash
# sitemap-fp — Radar catalogue fingerprints for African Shopify stores from their public product
# sitemaps (products.json is refused on most requests). Its own job, so it never waits behind the
# catalog-enrich steps. ~2,000 stores per run, 2 at a time through the Webshare fleet; 5 refusals (429)
# in a row end the run. Driven by ~/Library/LaunchAgents/com.tembo.sitemap-fp.plist (hourly; a run
# still going when the next one is due is skipped).
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
LOCK="/tmp/tembo-sitemap-fp.lock"
if ! mkdir "$LOCK" 2>/dev/null; then echo "sitemap-fp: previous run still going — skipping"; exit 0; fi
trap 'rmdir "$LOCK"' EXIT
node --env-file=.env.local scripts/heartbeat.mjs sitemap-fp >/dev/null 2>&1 || true
echo "===== sitemap-fp $(date '+%F %T') ====="
# 3h wall-clock cap (macOS has no `timeout`), so a stuck run can't hold the lock forever.
STORE_PROBE_PROXY_FILE="$HOME/shopify-radar/proxies.txt" \
  perl -e 'alarm shift; exec @ARGV or die "exec: $!"' 10800 \
  node --no-warnings --env-file=.env.local scripts/sitemap-fp.mjs --limit 2000 --concurrency 2 || echo "!! sitemap-fp failed or capped"
echo "===== sitemap-fp done $(date '+%F %T') ====="
