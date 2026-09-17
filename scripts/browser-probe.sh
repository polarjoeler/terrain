#!/bin/bash
# Browser FALLBACK probe — drains the payment probe's un-readable tail (mostly `no_variant`:
# products.json Cloudflare-blocked or JS-rendered) with a real headless Chromium, which finds a
# product where the fast HTTP probe couldn't. ~10% of the tail is recoverable this way; the rest
# are genuinely empty / password-protected / out-of-stock and stay uncatchable.
#
# Shares the same mkdir lock as the HTTP payment probes so the two never write checkout_cache.json
# at once. Low concurrency (browsers are heavy). Driven by com.tembo.browser-probe.plist.
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

LOCK="$HOME/shopify-radar/.probe.lock"
if [ -d "$LOCK" ]; then
  age=$(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || echo 0) ))
  [ "$age" -gt 5400 ] && rmdir "$LOCK" 2>/dev/null
fi
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "[$(date '+%F %T')] probe lock held — skipping browser pass this cycle."; exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

echo "===== browser probe $(date '+%F %T') ====="
PY="$HOME/shopify-radar/.venv/bin/python"
if [ -x "$PY" ] && "$PY" -c "import playwright" 2>/dev/null; then
  # Target the no_variant bucket first (biggest + highest-yield via a browser). Rotate the 100-IP
  # Webshare pool (one IP per store) so the JS-checkout page loads don't get a single IP blocked,
  # and run more contexts now that the pool removes the IP bottleneck.
  ( cd "$HOME/shopify-radar" && STORE_PROBE_PROXY_FILE="$HOME/shopify-radar/proxies.txt" \
      "$PY" checkout_probe_browser.py --note no_variant --limit 1000 --concurrency 6 ) \
    || echo "!! browser probe failed (continuing)"
  node --env-file=.env.local scripts/sync-checkout-payments.mjs || echo "!! checkout sync failed (continuing)"
else
  echo "playwright not installed ($PY) — run: $PY -m pip install playwright && $PY -m playwright install chromium"
fi
echo "===== browser probe done $(date '+%F %T') ====="
