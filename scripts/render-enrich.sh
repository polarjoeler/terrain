#!/bin/bash
# Render-enrich — tech + payment enrichment for the stores plain-fetch CAN'T read (Cloudflare/Akamai
# JS-challenge pages + client-rendered SPAs). Drives a real headless Chromium (Playwright): renders
# the page AND records every network-request host (the most reliable gateway signal there is).
# SECOND pass — deep-enrich runs first (cheap); this mops up what it couldn't reach. Own-domain
# render, so NO shared Shopify-edge rate budget; heavy per page, so low concurrency.
#   Driven by ~/Library/LaunchAgents/com.tembo.render-enrich.plist (every 12h).
#   Target = published ZA, technologies IS NULL, deep_enriched_at set (deep-enrich tried + failed),
#   ordered by revenue so the top stores render first; a finite backlog that then just tops up.
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

node --env-file=.env.local scripts/heartbeat.mjs render-enrich "ZA bot-blocked tail" >/dev/null 2>&1 || true
echo "===== render-enrich $(date '+%F %T') ====="

node --env-file=.env.local scripts/render-enrich.mjs --country ZA --limit 150 --concurrency 2 || echo "!! render-enrich failed"

node --env-file=.env.local scripts/heartbeat.mjs render-enrich "idle — done" >/dev/null 2>&1 || true
echo "===== render-enrich done $(date '+%T') ====="
