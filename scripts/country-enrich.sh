#!/bin/bash
# Country enricher — attribute the newly-banked global stores that land country-null (generic-TLD
# Shopify from CT_BANK_GLOBAL) by reading Shopify.country / currency from their storefront. Hits
# each store's OWN domain (a homepage GET), so no Shopify-edge budget; a modest per-run limit keeps
# each run short and country_checked_at marks attempts so it never redoes work.
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
node --env-file=.env.local scripts/heartbeat.mjs country >/dev/null 2>&1 || true
echo "===== country-enrich $(date '+%F %T') ====="
node --env-file=.env.local scripts/country-enrich.mjs --null-country --limit 800 --concurrency 10 || echo "!! country-enrich failed (continuing)"
echo "===== country-enrich done $(date '+%F %T') ====="
