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

# ---------------------------------------------------------------- watchdog ---
# A hung step (a browser context that never returned) once blocked launchd's
# single-instance slot for 6+ DAYS, silently halting all enrichment. Cap the whole
# run: if it exceeds MAX_RUNTIME, kill the entire process group so launchd's next
# tick (every 4h) starts fresh instead of skipping. macOS has no `timeout`; this
# is the portable equivalent. The trap cancels it on a normal finish.
MAX_RUNTIME=${MAX_RUNTIME:-5400}   # 90 min — comfortably longer than a healthy run
(
  sleep "$MAX_RUNTIME"
  echo "!! pipeline exceeded ${MAX_RUNTIME}s at $(date '+%H:%M:%S') — killing run so it can't block the schedule"
  pkill -P $$ 2>/dev/null       # direct children (node/python steps + their trees)
  kill -TERM -$$ 2>/dev/null    # whole process group
  sleep 10
  kill -KILL -$$ 2>/dev/null
) &
WATCHDOG_PID=$!
trap 'kill "$WATCHDOG_PID" 2>/dev/null' EXIT

# Step 1: pull the cert-transparency discovery feed (Sheet) into Postgres so the
# newest finds appear and discovered_at stays fresh. Runs locally — the Mac has
# the Sheet creds + DATABASE_URL — so no web app / CRON_SECRET / Vercel needed.
echo "--- 1/5 sync discovery feed ---"
node --env-file=.env.local scripts/sync-sheet.mjs || echo "!! sync step failed (continuing)"

# Land discoveries from the direct CT log tailer (ct_tail.py, crt.sh-independent).
# It runs continuously and appends confirmed Shopify .za domains to a feed file;
# this lands the new ones and prints the overlap vs what we already had — our
# live recall read against an independent signal.
echo "--- 1b land CT-tail discoveries (crt.sh-independent) ---"
node --env-file=.env.local scripts/land-ct-discoveries.mjs || echo "!! CT-tail landing failed (continuing)"

echo "--- 2/5 fingerprint catalogue ---"
node --env-file=.env.local scripts/radar-fingerprint.mjs --all || echo "!! fingerprint step failed (continuing)"

echo "--- 3/5 AI enrich (category + description) ---"
node --env-file=.env.local scripts/ai-enrich.mjs --all || echo "!! ai-enrich step failed (continuing)"

echo "--- 4/5 monitor brands ---"
node --env-file=.env.local scripts/radar-monitor.mjs || echo "!! monitor step failed (continuing)"

echo "--- 4b market fraud sweep ---"
node --env-file=.env.local scripts/radar-fraud-sweep.mjs --write || echo "!! fraud-sweep step failed (continuing)"

echo "--- 5/6 domain & email intel ---"
node --env-file=.env.local scripts/radar-domain-watch.mjs || echo "!! domain-watch step failed (continuing)"

# Step 6: payment coverage — refresh the value-ranked queue, browser-probe the
# top N highest-value stores that still lack a verified gateway, then sync the
# results into imported_stores.payments + shipping_providers. The probe is now pure
# HTTP (no browser) — it parses the enabled gateways from the server-rendered
# checkout HTML and shipping providers (incl. TUNL international) from
# /cart/shipping_rates.json — so it's ~10-50x cheaper and far faster, letting us
# probe many more per run. Still capped: a probe creates a cart/checkout record in
# the merchant's admin (but enters no email, so no abandoned-cart recovery fires).
echo "--- 6/7 payments (queue + checkout probe + sync) ---"
node --env-file=.env.local scripts/payment-queue.mjs --limit 2000 >/dev/null 2>&1 || echo "!! payment-queue failed (continuing)"
PROBE_PY="$HOME/shopify-radar/.venv/bin/python"
if [ -x "$PROBE_PY" ]; then
  ( cd "$HOME/shopify-radar" && "$PROBE_PY" checkout_probe.py \
      --from-file /Users/joel/storepulse/feed/payment-queue.txt --limit 2000 --concurrency 12 ) \
    || echo "!! checkout probe failed (continuing)"
  node --env-file=.env.local scripts/sync-checkout-payments.mjs || echo "!! checkout sync failed (continuing)"
else
  echo "checkout probe env ($PROBE_PY) not found — skipping payments"
fi

# Step 7: liveness re-check — re-verify a batch of stores (value-ranked, skips
# anything checked in the last 10 days) so live_status stays current and the
# Insights "Store survival & churn" tracks real forward churn instead of freezing
# at the import snapshot. Lightweight HTTP (products.json), not a checkout probe.
echo "--- 7/7 liveness re-check ---"
node --env-file=.env.local scripts/verify-liveness.mjs --limit 600 --min-age-days 10 --concurrency 10 \
  || echo "!! liveness step failed (continuing)"

# Trigger the daily market-insights snapshot (the page computes + upserts it).
echo "--- insights snapshot ---"
curl -s -o /dev/null -w "insights: HTTP %{http_code}\n" --max-time 60 https://terrain.tembocommerce.app/insights || echo "!! insights snapshot failed (continuing)"

# Catalog enrichment — capture product_count + AOV from public /products.json
# (footprint-free). Powers the revenue estimator + Lead Fit Score. Resumable.
echo "--- catalog enrich (product_count + AOV) ---"
node --env-file=.env.local scripts/catalog-enrich.mjs --limit 3000 || echo "!! catalog-enrich failed (continuing)"

# Homepage fingerprint scan — detect shipping/logistics apps (Shiprazor, TUNL, Bob
# Go…) that don't appear as a checkout carrier, and capture clean theme names.
echo "--- logistics/theme fingerprint scan ---"
node --env-file=.env.local scripts/logistics-scan.mjs --limit 3000 || echo "!! logistics-scan failed (continuing)"

# Per-provider snapshot → provider_snapshots (adoption/top-spot/exclusive), so the
# shareable provider dashboards' trend lines accrue. Idempotent per (provider, day).
echo "--- provider snapshots ---"
node --env-file=.env.local scripts/snapshot-providers.mjs || echo "!! provider snapshot failed (continuing)"

# Browse snapshot — precompute the dashboard Explorer's full dataset into a single
# jsonb row so the request path reads ONE row instead of marshaling ~13k wide rows
# (which timed out under this pass's concurrent DB load). Runs LAST, after enrichment,
# so today's catalog/contacts/launch-date fills show up in the browse view.
echo "--- browse snapshot refresh ---"
node --env-file=.env.local --experimental-strip-types scripts/refresh-browse-snapshot.mjs \
  || echo "!! browse snapshot refresh failed (continuing)"

echo "===== pipeline done $(date '+%H:%M:%S') ====="
