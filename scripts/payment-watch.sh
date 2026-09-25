#!/bin/bash
# Provider WATCH — re-probes every live store that currently carries Paystack, Stitch, or Peach
# Payments, regardless of the normal staleness gate, so switches away / gateway churn for these
# named providers are caught on a fixed cadence.
#
# RELIABILITY (2026-09-25): the old design was a SINGLE Sunday-05:00 launchd fire. If Chad was
# asleep at 05:00 and didn't wake to run it, launchd skipped the whole week — which is exactly
# what happened for the run of Sun 09-21 (no watch since ~09-14). Fixed two ways:
#   1. The plist now fires DAILY at 05:00 and 13:00 (many chances to catch a wake window), and
#   2. this script self-gates: it no-ops unless the last COMPLETED watch is >MIN_AGE_DAYS old.
# Net effect: effective cadence ~MIN_AGE_DAYS, but a missed wake is caught within hours at the
# next fire instead of costing a full week. Pass --force to run regardless of the gate.
#
#   Driven by ~/Library/LaunchAgents/com.tembo.payment-watch.plist (daily 05:00 + 13:00).
#
# Shares the mkdir probe lock with the hourly payments probe + the pipeline, so the two never
# write checkout_cache.json at the same time. Same rate discipline (concurrency 10) — the
# cohort is bounded (~3.5k), one HTTP checkout each.
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

PROVIDERS="paystack,stitch,peach"
MARKETS="AO,BW,CI,CM,DZ,EG,ET,GH,KE,LS,LY,MA,MU,MW,MZ,NA,NG,RW,SN,SO,SZ,TN,TZ,UG,ZA,ZM,ZW,JP"
OUT="feed/payment-watch.txt"
LOCK="$HOME/shopify-radar/.probe.lock"
MIN_AGE_DAYS="${WATCH_MIN_AGE_DAYS:-5}"

FORCE=0; [ "${1:-}" = "--force" ] && FORCE=1

# Freshness gate — skip cheaply if a watch COMPLETED within MIN_AGE_DAYS. Keyed on a dedicated
# 'payment-watch-done' heartbeat (written only on successful completion below), so a mid-flight
# start never satisfies the gate. This is what lets the plist fire daily without re-probing daily.
if [ "$FORCE" -eq 0 ]; then
  fresh=$(node --env-file=.env.local -e '
    import postgres from "postgres";
    const sql = postgres(process.env.DATABASE_URL, { prepare:false, max:1 });
    try {
      const [r] = await sql`SELECT last_run FROM agent_heartbeat WHERE task='"'"'payment-watch-done'"'"' ORDER BY last_run DESC LIMIT 1`;
      const days = r ? (Date.now() - new Date(r.last_run)) / 86400000 : 999;
      process.stdout.write(days.toFixed(2));
    } catch { process.stdout.write("999"); }
    await sql.end();
  ' 2>/dev/null || echo 999)
  if awk -v d="$fresh" -v m="$MIN_AGE_DAYS" 'BEGIN{exit !(d < m)}'; then
    echo "[$(date '+%F %T')] last completed watch ${fresh}d ago (< ${MIN_AGE_DAYS}d) — skipping (pass --force to override)."
    exit 0
  fi
  echo "[$(date '+%F %T')] last completed watch ${fresh}d ago (>= ${MIN_AGE_DAYS}d) — running."
fi

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
      --from-file "$HOME/storepulse/$OUT" --limit 4000 --concurrency 10 ) \
    || echo "!! checkout probe failed (continuing to sync partial)"
  node --env-file=.env.local scripts/sync-checkout-payments.mjs || echo "!! sync failed"
else
  echo "checkout probe env ($PROBE_PY) not found — skipping"
fi

# Dedicated completion marker — this is what the freshness gate above reads, so it MUST be
# written only after a real run finishes (not on start). /p/<provider> pages read this too.
node --env-file=.env.local scripts/heartbeat.mjs payment-watch-done "watch complete: $PROVIDERS" >/dev/null 2>&1 || true
node --env-file=.env.local scripts/heartbeat.mjs payment-watch "idle — watch complete" >/dev/null 2>&1 || true
echo "===== payment-watch done $(date '+%F %T') ====="
