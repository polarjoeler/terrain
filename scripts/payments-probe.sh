#!/bin/bash
# Dedicated payment/shipping probe — runs HOURLY (its own launchd job), decoupled
# from the 4-hour full pipeline. The HTTP checkout probe finishes a 1,500-store
# batch in ~25 min, so running it once every 4h left it idle most of the time and
# the ZA backlog (~10k) crawled. Hourly cadence ~4x's throughput and clears it fast.
#
# Shares a lock with the pipeline's own probe step (scripts/radar-pipeline.sh) via
# a mkdir lock, so the two never write checkout_cache.json at the same time.
#
#   Driven by ~/Library/LaunchAgents/com.tembo.payments-probe.plist (hourly).

set -u
cd /Users/joel/storepulse || exit 1
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

LOCK="$HOME/shopify-radar/.probe.lock"

# Clear a stale lock (a probe that died holding it) — older than 90 min is dead.
if [ -d "$LOCK" ]; then
  age=$(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || echo 0) ))
  [ "$age" -gt 5400 ] && rmdir "$LOCK" 2>/dev/null
fi
# Acquire the lock (mkdir is atomic); if another probe holds it, skip this hour.
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "[$(date '+%F %T')] probe lock held (pipeline or prior run) — skipping this hour."
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

echo "===== payments probe $(date '+%F %T') ====="

# Refresh the value-ranked queue (skips already-verified; re-surfaces >60d-stale so
# provider switches get caught), then HTTP-probe the top batch and sync results.
node --env-file=.env.local scripts/payment-queue.mjs --limit 8000 >/dev/null 2>&1 \
  || echo "!! payment-queue failed (continuing)"
PROBE_PY="$HOME/shopify-radar/.venv/bin/python"
if [ -x "$PROBE_PY" ]; then
  ( cd "$HOME/shopify-radar" && "$PROBE_PY" checkout_probe.py \
      --from-file /Users/joel/storepulse/feed/payment-queue.txt --limit 1500 --concurrency 10 ) \
    || echo "!! checkout probe failed (continuing)"
  node --env-file=.env.local scripts/sync-checkout-payments.mjs || echo "!! sync failed (continuing)"
else
  echo "checkout probe env ($PROBE_PY) not found — skipping"
fi

echo "===== payments probe done $(date '+%T') ====="
