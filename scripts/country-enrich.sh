#!/bin/bash
# Country enricher — attribute the newly-banked global stores that land country-null (generic-TLD
# Shopify from CT_BANK_GLOBAL) by reading Shopify.country / currency from their storefront. Hits
# each store's OWN domain, but Shopify custom domains resolve to Shopify's edge, so it rotates across
# the Webshare fleet (measured 2026-11-09: 0 429s in 300 requests): 500 paced stores per run,
# likeliest African stores first; 429s stop the run. Without the proxy file it would spend the home IP.
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
node --env-file=.env.local scripts/heartbeat.mjs country >/dev/null 2>&1 || true
echo "===== country-enrich $(date '+%F %T') ====="
STORE_PROBE_PROXY_FILE="$HOME/shopify-radar/proxies.txt" node --env-file=.env.local scripts/country-enrich.mjs --null-country --limit 500 --concurrency 2 --pace-ms 1500 || echo "!! country-enrich failed (continuing)"
echo "===== country-enrich done $(date '+%F %T') ====="
