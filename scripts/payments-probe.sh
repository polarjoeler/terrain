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
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Cache guard (2026-09-24 incident): checkout_cache.json is read whole into one string. Past ~512MB
# it exceeds the max string size and EVERY run dies "Cannot create a string longer than 0x1fffffe8"
# → "No un-probed stores" and silent zero throughput. Rotate it well before that. The DB is the
# source of truth (payment-queue picks by payments_checked_at IS NULL), so a fresh cache is harmless.
CACHE="$HOME/shopify-radar/checkout_cache.json"
if [ -f "$CACHE" ]; then
  sz=$(stat -f %z "$CACHE" 2>/dev/null || echo 0)
  if [ "$sz" -gt 419430400 ]; then
    mv "$CACHE" "$CACHE.rotated-$(date +%Y%m%d%H%M)" 2>/dev/null
    echo "[$(date '+%F %T')] rotated checkout_cache.json (${sz}B > 400MB) — avoids the 512MB read crash."
  fi
fi

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

# Target markets ONLY (Africa + JP) — the markets we sell into. Without this scope the queue
# is newest-discovered-first GLOBALLY, so the huge global CT-tail flow (UK/DE/AU/…) hijacks the
# probe budget away from ZA/KE/NG. Matches radar-pipeline.sh's MARKETS.
MARKETS="AO,BW,CI,CM,DZ,EG,ET,GH,KE,LS,LY,MA,MU,MW,MZ,NA,NG,RW,SN,SO,SZ,TN,TZ,UG,ZA,ZM,ZW,JP"

# Refresh the value-ranked queue (skips already-verified; re-surfaces >60d-stale so
# provider switches get caught), then HTTP-probe the top batch and sync results.
node --env-file=.env.local scripts/payment-queue.mjs --limit 8000 --country "$MARKETS" >/dev/null 2>&1 \
  || echo "!! payment-queue failed (continuing)"
PROBE_PY="$HOME/shopify-radar/.venv/bin/python"
if [ -x "$PROBE_PY" ]; then
  # Route through the Webshare pool (one proxy per store) so Shopify-edge probing isn't pinned to ONE
  # residential IP's rate budget — conc 24 direct violates the "never burst one IP" rule, and the pool
  # (~100 IPs) lets us run high concurrency safely AND raise it later. (NB: this removes the single-IP
  # ceiling; it's not proven to be the main cause of the fresh-store payment gap — the no_gateways_found
  # hard tail + queue health are also suspects, to be diagnosed separately.) If proxies.txt is absent on
  # a box, checkout_probe.py falls back to direct automatically, so this is safe everywhere.
  ( cd "$HOME/shopify-radar" && STORE_PROBE_PROXY_FILE="$HOME/shopify-radar/proxies.txt" "$PROBE_PY" checkout_probe.py \
      --from-file "$HOME/storepulse/feed/payment-queue.txt" --limit 2500 --concurrency 24 ) \
    || echo "!! checkout probe failed (continuing)"
  node --env-file=.env.local scripts/sync-checkout-payments.mjs || echo "!! sync failed (continuing)"
else
  echo "checkout probe env ($PROBE_PY) not found — skipping"
fi

echo "===== payments probe done $(date '+%T') ====="
