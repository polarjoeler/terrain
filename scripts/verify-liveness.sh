#!/bin/bash
# Liveness verification — and the ONLY thing that writes churn_log.
#
# WHY THIS EXISTS AS ITS OWN JOB. verify-liveness.mjs used to be step 7/7 of radar-pipeline.sh.
# That pipeline is not loaded on Rex (no com.tembo.radar-pipeline in launchctl, and no plist for it
# in ~/Library/LaunchAgents), so the script simply stopped running: churn_log's last row is
# 2026-10-24 and 6,868 stores went dead or migrated in the following fortnight with no churn row at
# all. Insights counts churn by died_at, so that period reads as near-zero churn to customers.
#
# It is NOT enough to reload the pipeline: step 1 of it writes store_fingerprints, the 273 MB
# Radar-v1 table being retired, so reloading restarts a writer into a dying table. Hence a
# dedicated job for the one step that still earns its keep.
#
# RATE BUDGET — the reason the numbers here are small. This hits each store's /products.json
# DIRECTLY from Rex's residential IP, the same budget contact-enrich uses (~1,200/day direct is
# ~1% throttled; 24k/day is 89%). A THROTTLED read looks exactly like a dead store, which is how
# the first liveness-tail run at concurrency 12 mislabelled frozen stores. So: concurrency 4, 300
# stores every 12h (~600/day), and verify-liveness still needs 2 consecutive misses before it
# calls anything dead. Do not raise these to "catch up" — a faster sweep reports false deaths.
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
source "$HOME/storepulse/scripts/lib/markets.sh"

node --env-file=.env.local scripts/heartbeat.mjs verify-liveness "starting" >/dev/null 2>&1 || true
echo "===== verify-liveness $(date '+%F %T') ====="

# NOT wrapped in `|| echo`. Step 7 of radar-pipeline.sh was, which meant a failing liveness step
# left the pipeline reporting success — the failure mode that hid this lane dying for three weeks.
# A non-zero exit here is visible to launchctl and to the hourly health check.
node --env-file=.env.local scripts/verify-liveness.mjs \
  --country "$MARKETS" --min-age-days 7 --limit 300 --concurrency 4
rc=$?

node --env-file=.env.local scripts/heartbeat.mjs verify-liveness "idle — done" >/dev/null 2>&1 || true
echo "===== verify-liveness done $(date '+%F %T') rc=$rc ====="
exit $rc
