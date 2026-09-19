#!/bin/bash
# Cert-transparency launch-date fallback (scripts/cert-launch.mjs) — dates undated live stores from
# their earliest SSL cert via crt.sh. crt.sh is flaky, so failures retry on later runs. No Shopify
# IP needed (crt.sh is a different host), so it runs independently of the residential-IP probes.
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
node --env-file=.env.local scripts/heartbeat.mjs cert >/dev/null 2>&1 || true
echo "===== cert-launch $(date '+%F %T') ====="
node --env-file=.env.local scripts/cert-launch.mjs --limit 500 --concurrency 3 || echo "!! cert-launch failed (continuing)"
echo "===== cert-launch done $(date '+%F %T') ====="
