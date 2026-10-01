#!/bin/bash
# Subscription detection — three lanes, cheapest first. Driven by
# ~/Library/LaunchAgents/com.tembo.subscriptions.plist (daily).
#   1. derive-subscriptions: FREE, no HTTP — reads apps/plugins/technologies/description we already
#      captured. Catches Store-API-disabled Woo and logged app installs. Re-run daily as enrichment grows.
#   2. detect --platform woocommerce: Woo Store API on stores' OWN domains — no Shopify-edge budget,
#      so it safely chews the ~10k unscanned Woo backlog.
#   3. detect (both lanes, small+slow): the Shopify lane is rate-limited on the shared edge, so take
#      a small bite each night (429s are left to retry now, never poisoned). Full Shopify coverage
#      needs residential proxies (see detect-subscriptions header) — this is the free trickle.
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

node --env-file=.env.local scripts/heartbeat.mjs subscriptions "derive + probe" >/dev/null 2>&1 || true
echo "===== subscriptions $(date '+%F %T') ====="

echo "--- 1. derive from existing enrichment data (free) ---"
node --env-file=.env.local scripts/derive-subscriptions.mjs || echo "!! derive failed (continuing)"

echo "--- 2. Woo Store API backlog (own-domain, unmetered) ---"
node --env-file=.env.local scripts/detect-subscriptions.mjs --platform woocommerce --limit 2500 --concurrency 6 || echo "!! woo detect failed (continuing)"

echo "--- 3. Shopify edge trickle (rate-limited; small bite, retries not poisoned) ---"
node --env-file=.env.local scripts/detect-subscriptions.mjs --platform shopify --limit 600 --concurrency 2 || echo "!! shopify detect failed (continuing)"

node --env-file=.env.local scripts/heartbeat.mjs subscriptions "idle — done" >/dev/null 2>&1 || true
echo "===== subscriptions done $(date '+%T') ====="
