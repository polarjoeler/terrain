#!/bin/bash
# Other-CMS enrichment probes — keep the growing Wix / Magento cohorts classified and
# payment-read as discovery banks more of them. Homepage GETs to the stores' OWN domains
# (no Shopify-edge rate budget), small bounded cohorts, so a couple of times a week is plenty.
#   Driven by ~/Library/LaunchAgents/com.tembo.cms-probe.plist (every ~2 days).
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

node --env-file=.env.local scripts/heartbeat.mjs cms-probe "wix + magento" >/dev/null 2>&1 || true
echo "===== cms-probe $(date '+%F %T') ====="

echo "--- wix ---"
node --env-file=.env.local scripts/wix-probe.mjs --limit 800 --concurrency 8 || echo "!! wix-probe failed"
echo "--- magento ---"
node --env-file=.env.local scripts/magento-probe.mjs --limit 500 --concurrency 6 || echo "!! magento-probe failed"

node --env-file=.env.local scripts/heartbeat.mjs cms-probe "idle — done" >/dev/null 2>&1 || true
echo "===== cms-probe done $(date '+%T') ====="
