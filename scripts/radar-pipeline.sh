#!/bin/bash
# Radar pipeline — the full enrichment chain in order, run on an interval while
# the Mac is on. Replaces the three separate daily jobs with one recurring job:
#   1. fingerprint the SA universe   (store_fingerprints)
#   2. AI category + description      (imported_stores)
#   3. monitor stores vs brands       (radar_detections)
#   4. domain & email intel           (radar_domain_watches + SPF/DMARC posture)
#
# Every step is resumable/idempotent, so the first run does the full backfill and
# each later run only touches new/stale stores — cheap, and keeps discoveries
# fresh through the day. Driven by ~/Library/LaunchAgents/com.tembo.radar-pipeline.plist.
# launchd won't start a second copy while one is still running, so runs never overlap.

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

cd /Users/joel/storepulse || exit 1

echo "===== radar pipeline $(date '+%Y-%m-%d %H:%M:%S') ====="

# Step 0: pull the cert-transparency discovery feed (Sheet) into Postgres so the
# newest finds appear and discovered_at stays fresh. Runs on prod via curl (prod
# holds the Sheet creds); needs CRON_SECRET in .env.local + Vercel to authorise.
echo "--- 1/5 sync discovery feed ---"
CRON_SECRET=$(grep -E '^CRON_SECRET=' .env.local 2>/dev/null | cut -d= -f2- | tr -d '"')
curl -s --max-time 120 -H "Authorization: Bearer ${CRON_SECRET}" \
  https://terrain.tembocommerce.app/api/admin/sync-sheet \
  -w "sync: HTTP %{http_code}\n" || echo "!! sync step failed (continuing)"

echo "--- 2/5 fingerprint catalogue ---"
node --env-file=.env.local scripts/radar-fingerprint.mjs --all || echo "!! fingerprint step failed (continuing)"

echo "--- 3/5 AI enrich (category + description) ---"
node --env-file=.env.local scripts/ai-enrich.mjs --all || echo "!! ai-enrich step failed (continuing)"

echo "--- 4/5 monitor brands ---"
node --env-file=.env.local scripts/radar-monitor.mjs || echo "!! monitor step failed (continuing)"

echo "--- 5/5 domain & email intel ---"
node --env-file=.env.local scripts/radar-domain-watch.mjs || echo "!! domain-watch step failed (continuing)"

# Trigger the daily market-insights snapshot (the page computes + upserts it).
echo "--- insights snapshot ---"
curl -s -o /dev/null -w "insights: HTTP %{http_code}\n" --max-time 60 https://terrain.tembocommerce.app/insights || echo "!! insights snapshot failed (continuing)"

echo "===== pipeline done $(date '+%H:%M:%S') ====="
