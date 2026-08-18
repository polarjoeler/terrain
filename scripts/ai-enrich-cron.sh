#!/bin/bash
# Daily AI enrichment sweep — categorises + describes newly-discovered live SA
# stores that still lack a category. Resumable by design: the script only touches
# rows where ai_enriched_at IS NULL, so re-runs never re-fetch or re-charge.
#
# Driven by ~/Library/LaunchAgents/com.tembo.ai-enrich.plist (daily).
# Runs from the Mac on purpose: merchant-site fetches are throttled/unreliable
# from serverless, so this heavy I/O lives here, and the web app only reads.

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"   # make `node` available under launchd's minimal PATH

cd /Users/joel/storepulse || exit 1

echo "=== ai-enrich sweep $(date '+%Y-%m-%d %H:%M:%S') ==="
node --env-file=.env.local scripts/ai-enrich.mjs --all
echo "=== done $(date '+%H:%M:%S') ==="
