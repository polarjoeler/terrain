#!/bin/bash
# completeness coordinator — ZA-first auto-advance through Africa. Owns the own-domain enrichment
# lanes (deep-enrich/hosting-enrich/contact-enrich) so nothing double-runs. All own-domain/DNS — no
# Shopify-edge budget. Driven by com.tembo.completeness.plist.
set -u
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
cd "$HOME/storepulse" || exit 1
node --env-file=.env.local scripts/heartbeat.mjs completeness "starting" >/dev/null 2>&1 || true
echo "===== completeness $(date '+%F %T') ====="
node --env-file=.env.local scripts/completeness.mjs --auto --limit 4000 || echo "!! completeness failed"
node --env-file=.env.local scripts/heartbeat.mjs completeness "idle — done" >/dev/null 2>&1 || true
