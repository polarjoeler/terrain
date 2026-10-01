#!/bin/bash
# Deep-enrich non-Shopify stores — ONE homepage fetch → theme/plugins/tech/subscription signals +
# banked homepage_text (for later local-LLM passes). Own-domain fetches, so NO shared Shopify-edge
# rate budget — safe at normal concurrency. This is the first regular commerce-tech enrichment the
# ~12 banked CMSs (BASE/cafe24/EC-CUBE/Squarespace/ShopStar/PrestaShop/…) have ever had.
#   Driven by ~/Library/LaunchAgents/com.tembo.deep-enrich.plist (daily).
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

node --env-file=.env.local scripts/heartbeat.mjs deep-enrich "non-Shopify homepages" >/dev/null 2>&1 || true
echo "===== deep-enrich $(date '+%F %T') ====="

# Default scope = focus markets (Africa + JP); non-Shopify only. 3000/night clears the backlog over
# a handful of runs and then just tops up newly-discovered stores.
node --env-file=.env.local scripts/deep-enrich.mjs --limit 3000 --concurrency 8 || echo "!! deep-enrich failed"

node --env-file=.env.local scripts/heartbeat.mjs deep-enrich "idle — done" >/dev/null 2>&1 || true
echo "===== deep-enrich done $(date '+%T') ====="
