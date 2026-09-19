#!/bin/bash
# WooCommerce launch dating from the WP REST API (oldest post/page/product). Own-domain GETs, no
# Shopify-edge budget. wp_dated_at marks attempts so it only tops up newly-landed undated Woo.
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
node --env-file=.env.local scripts/heartbeat.mjs woo-date >/dev/null 2>&1 || true
echo "===== woo-date $(date '+%F %T') ====="
node --env-file=.env.local scripts/woo-date.mjs --limit 800 --concurrency 10 || echo "!! woo-date failed (continuing)"
echo "===== woo-date done $(date '+%F %T') ====="
