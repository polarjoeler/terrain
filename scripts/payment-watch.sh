#!/bin/bash
# Weekly provider WATCH — re-probes every live store that currently carries Paystack, Stitch,
# or Peach Payments, regardless of the normal staleness gate, so switches away / gateway churn
# for these named providers are caught on a fixed weekly cadence. Runs SUNDAY (early) so fresh
# switches are ready for the Monday inbox drop.
#
#   Driven by ~/Library/LaunchAgents/com.tembo.payment-watch.plist (Sundays 05:00).
#
# Shares the mkdir probe lock with the hourly payments probe + the pipeline, so the two never
# write checkout_cache.json at the same time. Same rate discipline (concurrency 10) — the
# cohort is bounded (~2.5k), one HTTP checkout each, once a week.
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

PROVIDERS="paystack,stitch,peach"
MARKETS="AO,BW,CI,CM,DZ,EG,ET,GH,KE,LS,LY,MA,MU,MW,MZ,NA,NG,RW,SN,SO,SZ,TN,TZ,UG,ZA,ZM,ZW,JP"
OUT="feed/payment-watch.txt"
LOCK="$HOME/shopify-radar/.probe.lock"

node --env-file=.env.local scripts/heartbeat.mjs payment-watch "watch: $PROVIDERS" >/dev/null 2>&1 || true

# Clear a stale lock (dead holder > 90 min), then acquire; if the hourly probe holds it, wait a
# little and retry a few times rather than skipping the whole week.
for attempt in 1 2 3 4 5 6; do
  if [ -d "$LOCK" ]; then
    age=$(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || echo 0) ))
    [ "$age" -gt 5400 ] && rmdir "$LOCK" 2>/dev/null
  fi
  mkdir "$LOCK" 2>/dev/null && break
  echo "[$(date '+%F %T')] probe lock held — retry $attempt/6 in 5m"; sleep 300
done
if [ ! -d "$LOCK" ]; then echo "could not acquire probe lock after retries — aborting this week."; exit 0; fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

echo "===== payment-watch $(date '+%F %T') | providers: $PROVIDERS ====="

node --env-file=.env.local scripts/payment-queue.mjs \
  --providers "$PROVIDERS" --country "$MARKETS" --out "$OUT" --limit 0 \
  || { echo "!! watch queue build failed"; exit 1; }

PROBE_PY="$HOME/shopify-radar/.venv/bin/python"
if [ -x "$PROBE_PY" ]; then
  ( cd "$HOME/shopify-radar" && "$PROBE_PY" checkout_probe.py \
      --from-file "$HOME/storepulse/$OUT" --limit 3000 --concurrency 10 ) \
    || echo "!! checkout probe failed (continuing to sync partial)"
  node --env-file=.env.local scripts/sync-checkout-payments.mjs || echo "!! sync failed"
else
  echo "checkout probe env ($PROBE_PY) not found — skipping"
fi

node --env-file=.env.local scripts/heartbeat.mjs payment-watch "idle — weekly watch complete" >/dev/null 2>&1 || true
echo "===== payment-watch done $(date '+%F %T') ====="
