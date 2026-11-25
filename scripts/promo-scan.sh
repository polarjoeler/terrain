#!/bin/bash
# promo-scan — Black Friday 2026 deals lane (DESIGN-black-friday-2026.md). Reads the live promo offers
# of the top ~1,500 ZA stores into store_promos for tembocommerce.africa/za/black-friday.
# Driven by ~/Library/LaunchAgents/com.tembo.promo-scan.plist (06:00 and 15:00 Rex time; each run skips
# stores scanned in the last 18h, so the second run only picks up what the first missed — switch to
# --stale-hours 8 for the 26–30 Nov twice-daily window). Unload after 1 Dec.
# Shopify homepages are DIRECT on the home IP: contact-enrich must be paused while this runs daily.
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
LOCK="/tmp/tembo-promo-scan.lock"
if ! mkdir "$LOCK" 2>/dev/null; then echo "promo-scan: previous run still going — skipping"; exit 0; fi
trap 'rmdir "$LOCK"' EXIT
node --env-file=.env.local scripts/heartbeat.mjs promo-scan >/dev/null 2>&1 || true
echo "===== promo-scan $(date '+%F %T') ====="
STALE="${PROMO_STALE_HOURS:-18}"
# 4h wall-clock cap (macOS has no `timeout`).
STORE_PROBE_PROXY_FILE="$HOME/shopify-radar/proxies.txt" \
LOCAL_LLM_URL="${LOCAL_LLM_URL:-http://localhost:11434/v1}" \
  perl -e 'alarm shift; exec @ARGV or die "exec: $!"' 14400 \
  node --no-warnings --env-file=.env.local scripts/promo-scan.mjs --top 1500 --extra-other 2500 --concurrency 2 --pause-ms 1200 --stale-hours "$STALE" --llm \
  || echo "!! promo-scan failed or capped"
# Sale products behind each deal (Woo Store API + the top 300 Shopify BF collection pages). Runs after
# the scan, under the same lock, so the two never share the Shopify budget at once: ~900 Shopify
# homepages + ≤300 collection pages a day stays inside the ~1,200/day clean rate.
perl -e 'alarm shift; exec @ARGV or die "exec: $!"' 7200 \
  node --no-warnings --env-file=.env.local scripts/promo-products.mjs --shopify-top 300 --stale-hours "$STALE" \
  || echo "!! promo-products failed or capped"
# Rebuild tembocommerce.africa/za/black-friday from what this run found. The Tembo build reads the
# database through a read-only role (Joel's decision 3, 2026-11-18); Rex can't push to GitHub, so a
# Vercel deploy hook is the refresh. TEMBO_BF_DEPLOY_HOOK lives in .env.local on Rex.
HOOK="$(grep -E '^TEMBO_BF_DEPLOY_HOOK=' .env.local 2>/dev/null | cut -d= -f2- | tr -d '"')"
if [ -n "$HOOK" ]; then curl -fsS -X POST "$HOOK" >/dev/null && echo "tembo black-friday rebuild requested" || echo "!! tembo deploy hook failed"; fi
echo "===== promo-scan done $(date '+%F %T') ====="
