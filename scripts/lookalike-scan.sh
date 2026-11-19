#!/bin/bash
# Radar Watch — look-alike domains of the top African stores (scripts/lookalike-scan.mjs).
# Daily: scans domains created since the last run (full pass on Sundays), then catalogue-checks up
# to 60 tier-A candidates against their brand (~30-600 polite requests via the Webshare fleet).
#   Driven by ~/Library/LaunchAgents/com.tembo.lookalike-scan.plist (daily).
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
LOCK="logs/.lookalike-scan.lock"
if ! mkdir "$LOCK" 2>/dev/null; then echo "lookalike-scan already running"; exit 0; fi
trap 'rmdir "$LOCK"' EXIT

node --env-file=.env.local scripts/heartbeat.mjs lookalike-scan "scanning" >/dev/null 2>&1 || true
echo "===== lookalike-scan $(date '+%F %T') ====="
STORE_PROBE_PROXY_FILE="$HOME/shopify-radar/proxies.txt" \
  node --env-file=.env.local scripts/lookalike-scan.mjs --confirm 60 || echo "!! lookalike-scan failed"
node --env-file=.env.local scripts/heartbeat.mjs lookalike-scan "idle — done" >/dev/null 2>&1 || true
echo "===== lookalike-scan done $(date '+%T') ====="
