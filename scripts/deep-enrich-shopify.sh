#!/bin/bash
# Shopify deep-enrich — runs on LUCY over the Rain line (the 2nd residential IP = a 2nd independent
# Shopify-edge rate budget). This is the lane that makes Rain pay for itself: Rex's deep-enrich is
# NON-Shopify only, and the payment/checkout lane already scales via the Webshare proxy fleet, so the
# Shopify homepage pass (theme / apps / subscription_tools — the "app coverage" gap) runs NOWHERE else.
# DIRECT residential fetch (deliberately NO Webshare — datacenter IPs get 429'd harder on Shopify edge),
# paced to the ~1,200/day single-IP ceiling (~1% throttle). Backlog ~103k Shopify stores; clears steadily.
#   Driven by ~/Library/LaunchAgents/com.tembo.deep-enrich-shopify.plist (daily). LUCY-ONLY — running a
#   second copy on any machine sharing an IP just re-creates contention (one Shopify crawler per IP).
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
unset STORE_PROBE_PROXY_FILE   # force DIRECT off the Rain IP — that IS the point of this lane

node --env-file=.env.local scripts/heartbeat.mjs deep-enrich-shopify "Shopify homepages (Rain)" >/dev/null 2>&1 || true
echo "===== deep-enrich-shopify $(date '+%F %T') ====="
node --env-file=.env.local scripts/deep-enrich.mjs --platform shopify --limit 1200 --concurrency 2 || echo "!! deep-enrich-shopify failed"
node --env-file=.env.local scripts/heartbeat.mjs deep-enrich-shopify "idle — done" >/dev/null 2>&1 || true
echo "===== deep-enrich-shopify done $(date '+%T') ====="
