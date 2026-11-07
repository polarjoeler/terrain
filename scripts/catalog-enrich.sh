#!/bin/bash
# Catalog-enrich lane: derives a real launch date (earliest product) + product_count from each
# store's products.json. Fanned across the Webshare proxy fleet so it is NOT capped by the single
# residential-IP Shopify-edge budget (~1,200/day direct). ORDER BY self-prioritises ZA/KE/NG then
# undated rows, so the focus-market launch metric fills first; spills to global undated after.
# catalog_checked_at marks attempts (terminal + success), so each run only tops up newly-landed rows.
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export STORE_PROBE_PROXY_FILE="$HOME/shopify-radar/proxies.txt"
node --env-file=.env.local scripts/heartbeat.mjs catalog-enrich >/dev/null 2>&1 || true
echo "===== catalog-enrich $(date '+%F %T') ====="
node --env-file=.env.local scripts/catalog-enrich.mjs --limit 1500 || echo "!! catalog-enrich failed (continuing)"
echo "===== catalog-enrich done $(date '+%F %T') ====="
