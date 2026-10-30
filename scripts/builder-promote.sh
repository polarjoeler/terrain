#!/bin/bash
# Promote banked (published=false) site-builder STORES → live leads, and demote banked brochures.
# CT→bulk_classify banks Wix/Squarespace/Webflow published=false; nothing else surfaces them, so
# ~1,500 new builder rows accrue every ~2 weeks and sit invisible. This lane is the missing
# promoter: for each builder it commerce-gates the banked visible-market pool via the Webshare
# proxy fleet (Wix/SQSP/Webflow all bot-block the bare IP) — real STORE → published=true, confirmed
# brochure → not_a_store (out of the retry pool), unreachable left banked for the next pass.
# Resumable, no marker column (promoted/demoted rows drop out of each builder's --promote query).
#   Driven by ~/Library/LaunchAgents/com.tembo.builder-promote.plist (weekly).
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export STORE_PROBE_PROXY_FILE="$HOME/shopify-radar/proxies.txt"

node --env-file=.env.local scripts/heartbeat.mjs builder-promote "banked builders → leads" >/dev/null 2>&1 || true
echo "===== builder-promote $(date '+%F %T') ====="

# Sequential, never concurrent — all three share the ONE residential proxy fleet's rate budget.
for b in wix squarespace webflow; do
  echo "--- $b ---"
  node --env-file=.env.local scripts/wix-store-audit.mjs --builder "$b" --promote --conc 8 2>&1 \
    | sed -n '/=== RESULT/,$p' || echo "!! $b promote failed"
done

node --env-file=.env.local scripts/heartbeat.mjs builder-promote "idle — done" >/dev/null 2>&1 || true
echo "===== builder-promote done $(date '+%T') ====="
