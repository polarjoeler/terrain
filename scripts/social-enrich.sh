#!/bin/bash
# Social-URL enricher — extracts brand social profiles (8 networks) from the homepage. Own-domain
# GETs, no Shopify-edge budget. social_checked_at marks attempts so it only tops up new stores.
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
node --env-file=.env.local scripts/heartbeat.mjs social >/dev/null 2>&1 || true
echo "===== social-enrich $(date '+%F %T') ====="
node --env-file=.env.local scripts/social-enrich.mjs --limit 800 --concurrency 10 || echo "!! social-enrich failed (continuing)"
echo "===== social-enrich done $(date '+%F %T') ====="
