#!/bin/bash
# confirm-cms — surface the banked non-Shopify/Woo "Other CMS" backlog into LIVE coverage as discovery
# keeps finding it. confirm-other-cms fetches each banked store's OWN homepage (no Shopify-edge rate
# budget), confirms it's a live named store, and publishes it — dedicated commerce platforms only
# (PrestaShop/Magento/Ecwid/… + Japan's BASE/STORES.jp/ColorMe/MakeShop/EC-CUBE/Cafe24/FutureShop).
# All focus markets (Africa + Japan). Bounded per run; re-runs only touch what's still banked.
#   Driven by ~/Library/LaunchAgents/com.tembo.confirm-cms.plist (every ~6h).
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

node --env-file=.env.local scripts/heartbeat.mjs confirm-cms "starting" >/dev/null 2>&1 || true
echo "===== confirm-cms $(date '+%F %T') ====="
node --env-file=.env.local scripts/confirm-other-cms.mjs --limit 8000 --concurrency 8 || echo "!! confirm-other-cms failed"
node --env-file=.env.local scripts/heartbeat.mjs confirm-cms "idle — done" >/dev/null 2>&1 || true
echo "===== confirm-cms done $(date '+%T') ====="
