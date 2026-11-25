#!/bin/bash
# Other-CMS enrichment probes — keep the growing Wix / Magento cohorts classified and
# payment-read as discovery banks more of them. Homepage GETs to the stores' OWN domains
# (no Shopify-edge rate budget), small bounded cohorts, so a couple of times a week is plenty.
#   Driven by ~/Library/LaunchAgents/com.tembo.cms-probe.plist (every ~2 days).
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

node --env-file=.env.local scripts/heartbeat.mjs cms-probe "wix + magento + other platforms" >/dev/null 2>&1 || true
echo "===== cms-probe $(date '+%F %T') ====="

echo "--- wix ---"
node --env-file=.env.local scripts/probe-cms.mjs --markets ZA,KE,NG --limit 2000 --concurrency 8 || echo "!! probe-cms failed"
node --env-file=.env.local scripts/wix-probe.mjs --limit 800 --concurrency 8 || echo "!! wix-probe failed"
echo "--- magento ---"
node --env-file=.env.local scripts/magento-probe.mjs --limit 500 --concurrency 6 || echo "!! magento-probe failed"
echo "--- other platforms (ShopStar, OpenCart, PrestaShop, Odoo, Ecwid, Squarespace, custom…) ---"
# Storefront gateway read + liveness for the visible stores no checkout probe covers. ZA/KE/NG
# first, then the rest of the visible markets; through the proxy fleet (own-domain hosts, ≤3 GETs).
STORE_PROBE_PROXY_FILE="$HOME/shopify-radar/proxies.txt" \
  node --env-file=.env.local scripts/other-cms-payments.mjs --limit 1000 --concurrency 6 || echo "!! other-cms-payments failed"

node --env-file=.env.local scripts/heartbeat.mjs cms-probe "idle — done" >/dev/null 2>&1 || true
echo "===== cms-probe done $(date '+%T') ====="
