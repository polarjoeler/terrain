#!/bin/bash
# Daily Radar catalogue-fingerprinting sweep — fills store_fingerprints for the
# SA universe so Brand Audits and the monitoring sweep have data to match
# against. Fetches each store's /products.json (throttled from serverless, so it
# runs here). Resumable: skips stores fingerprinted within the last 30 days.
#
# Driven by ~/Library/LaunchAgents/com.tembo.radar-fingerprint.plist (daily).
# Runs FIRST in the morning chain: fingerprint 05:30 -> ai-enrich 06:30 -> monitor 07:00.

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

cd /Users/joel/storepulse || exit 1

echo "=== radar-fingerprint sweep $(date '+%Y-%m-%d %H:%M:%S') ==="
node --env-file=.env.local scripts/radar-fingerprint.mjs --all
echo "=== done $(date '+%H:%M:%S') ==="
