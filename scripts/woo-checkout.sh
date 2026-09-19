#!/bin/bash
# Woo checkout probe — reads WooCommerce stores' enabled payment gateways from their OWN domain
# (Store API /wp-json/wc/store/v1/cart, else checkout HTML). No Shopify-edge rate budget involved
# (each request is a different host), so it runs independently of the residential-IP Shopify probes.
# A modest per-run limit keeps each run short; woo_checkout_at marks attempts so it never redoes
# work and just chips through new Woo discoveries + the network-fail retries.
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
node --env-file=.env.local scripts/heartbeat.mjs woo-checkout >/dev/null 2>&1 || true
echo "===== woo-checkout $(date '+%F %T') ====="
node --env-file=.env.local scripts/woo-checkout-probe.mjs --limit 500 --concurrency 10 || echo "!! woo-checkout failed (continuing)"
echo "===== woo-checkout done $(date '+%F %T') ====="
