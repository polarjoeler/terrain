#!/bin/bash
# Fresh-first LANDING — lands whatever ct_tail.py has collected into the DB: backfills
# discovered_at and stamps platform='Shopify' on brand-new domains. This is the CHEAP half of
# the fresh pass — pure DB work, no residential-IP / checkout probing — so it runs FREQUENTLY
# (every 30m) on its own, decoupled from the heavy 4-hourly radar-pipeline. Keeping it frequent
# is what keeps discovered_at current, so "new this week" + /ops never freeze between pipelines.
# Idempotent (ON CONFLICT COALESCE), so overlapping with the pipeline's own landing call is safe.
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
node --env-file=.env.local scripts/heartbeat.mjs discovery >/dev/null 2>&1 || true

echo "===== ct-land $(date '+%F %T') ====="
node --env-file=.env.local scripts/land-ct-discoveries.mjs || echo "!! CT-tail landing failed"
echo "===== ct-land done $(date '+%F %T') ====="
