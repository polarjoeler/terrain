#!/bin/bash
# DNS-only liveness (rate-exempt — no Shopify HTTP, no proxy/IP budget). Clears the never-checked
# backlog across the main sources. Driven by com.tembo.liveness.plist (every 6h). Once a source's
# never-checked set is drained the run is a no-op, so it self-throttles.
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
echo "===== liveness $(date '+%F %T') ====="
for SRC in storecensus ct_tail storeleads-2026-08 builtwith_woo_2019 woo_ct csv discovery cms_dns; do
  node --env-file=.env.local scripts/dns-liveness.mjs --source "$SRC" --limit 25000 2>&1 | tail -1
done
echo "===== liveness done $(date '+%F %T') ====="
