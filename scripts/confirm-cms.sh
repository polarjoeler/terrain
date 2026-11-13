#!/bin/bash
# confirm-cms — the publish path for banked stores on DEDICATED commerce platforms (PrestaShop/Magento/…,
# plus every `commerce` row of scripts/lib/hosted-platforms.json: Cafe24, YouCan, colorme, makeshop, …).
# confirm-other-cms fetches each banked store's OWN homepage (never the Shopify edge), confirms it's a
# live named store with a real commerce action, and publishes it. Worldwide, focus markets first;
# ≤2 fetches per platform edge at a time and ≤1,500 rows per platform per run. Site builders are NOT
# here — they need builder-promote's stricter catalogue check. Failed rows wait 7 days (unreachable)
# or 30 days (live, no cart) before a retry once cms_confirm_at exists (confirm-other-cms --migrate).
#   Driven by ~/Library/LaunchAgents/com.tembo.confirm-cms.plist (every ~6h).
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

node --env-file=.env.local scripts/heartbeat.mjs confirm-cms "starting" >/dev/null 2>&1 || true
echo "===== confirm-cms $(date '+%F %T') ====="
node --env-file=.env.local scripts/confirm-other-cms.mjs --limit 8000 --concurrency 8 --per-platform 1500 || echo "!! confirm-other-cms failed"
node --env-file=.env.local scripts/heartbeat.mjs confirm-cms "idle — done" >/dev/null 2>&1 || true
echo "===== confirm-cms done $(date '+%T') ====="
