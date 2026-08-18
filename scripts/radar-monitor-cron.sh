#!/bin/bash
# Daily Radar monitoring sweep — matches newly-fingerprinted stores against
# enrolled brand fingerprints and records clone detections (radar_detections).
# Pure computation over cached fingerprints, so it's cheap; runs after the
# morning enrichment sweep.
#
# Driven by ~/Library/LaunchAgents/com.tembo.radar-monitor.plist (daily).

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

cd /Users/joel/storepulse || exit 1

echo "=== radar-monitor sweep $(date '+%Y-%m-%d %H:%M:%S') ==="
node --env-file=.env.local scripts/radar-monitor.mjs
echo "=== done $(date '+%H:%M:%S') ==="
