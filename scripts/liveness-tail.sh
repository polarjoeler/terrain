#!/bin/bash
# Frozen/dead sweep over the checkout probe's un-readable tail. The HTTP probe parks stores it
# can't complete a checkout on as `no_variant` (exhausted at max-attempts). A spot-check (2026-09-27)
# found that bucket is ~17% genuinely dead (402 Shopify-frozen / 423 locked), ~40% live-but-not-
# checkout-completable (inquiry sites, out-of-stock — browser probe recovers 0% of them), rest
# ambiguous. The dead ones shouldn't count against payments coverage, but the scheduled DNS-liveness
# pass doesn't catch a 402 (the domain still resolves) and the pipeline's verify-liveness is value-
# capped, so this low-value tail never gets checked.
#
# This runs verify-liveness.mjs (which detects 402→frozen→dead) over EXACTLY that tail, so the
# frozen stores drop out of the live/scannable denominator while genuinely-live ones stay active.
#
#   Driven by ~/Library/LaunchAgents/com.tembo.liveness-tail.plist (weekly + RunAtLoad).
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

echo "===== liveness-tail $(date '+%F %T') ====="
PY="$HOME/shopify-radar/.venv/bin/python"
LIST="$HOME/storepulse/feed/no-variant-tail.txt"
mkdir -p "$HOME/storepulse/feed"

# Extract the exhausted no_variant domains (max-attempts, no gateway) from the probe cache.
"$PY" - "$HOME/shopify-radar/checkout_cache.json" "$LIST" <<'PY' || { echo "!! list build failed"; exit 1; }
import json, sys
cache = json.load(open(sys.argv[1]))
doms = [d for d, e in cache.items()
        if not e.get("gateways") and int(e.get("attempts", 0)) >= 3
        and str(e.get("note", "")).startswith("no_variant")]
open(sys.argv[2], "w").write("\n".join(sorted(set(doms))) + "\n")
print(f"no_variant tail: {len(doms)} domains → {sys.argv[2]}")
PY

# verify-liveness marks 402-frozen / 423-locked as dead (immediate — not 2-miss-gated); live stores
# stay active. --from-file re-checks exactly this list regardless of value rank.
# CONCURRENCY 4 (not 12): these are direct products.json hits on Shopify's edge from ONE residential
# IP, which shares a rate budget with every other store probe. The first run at 12 over ~7.6k stores
# burned the budget — frozen stores came back throttled (429/challenge) instead of their true 402, so
# the frozen-detector missed them and only DNS-dead ones were caught. Low concurrency gets true reads.
node --env-file=.env.local scripts/verify-liveness.mjs --from-file "$LIST" --concurrency 4 \
  || echo "!! verify-liveness failed"
echo "===== liveness-tail done $(date '+%T') ====="
