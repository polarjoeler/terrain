#!/bin/bash
# Daily AI enrichment sweep — categorises + describes newly-discovered live SA
# stores that still lack a category. Resumable by design: the script only touches
# rows where ai_enriched_at IS NULL, so re-runs never re-fetch or re-charge.
#
# Driven by ~/Library/LaunchAgents/com.tembo.ai-enrich.plist (daily).
# Runs from the Mac on purpose: merchant-site fetches are throttled/unreliable
# from serverless, so this heavy I/O lives here, and the web app only reads.

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"   # make `node` available under launchd's minimal PATH

cd /Users/joel/storepulse || exit 1

# Scoped to a market list — NOT --all. `--all` alone swept the entire ~600k global base (~$555 in
# Haiku) on stores in markets we don't sell. JP is the current priority (largest un-described base:
# ~16k Shopify stores missing category/description ≈ $16). Widen FOCUS to add markets (ZA is at 88%
# payments but its descriptions lag too; Africa ≈ +$31). Gated to rows still missing category/
# description, so re-runs never re-charge. NOTE: ai-enrich reads products.json, so it only enriches
# Shopify/NULL-platform stores — the non-Shopify JP CMS stores (BASE/Cafe24/EC-CUBE/Woo…) need a
# separate enrichment path.
FOCUS="JP"
echo "=== ai-enrich sweep $(date '+%Y-%m-%d %H:%M:%S') (markets: $FOCUS) ==="
node --env-file=.env.local scripts/ai-enrich.mjs --all --country "$FOCUS"
echo "=== done $(date '+%H:%M:%S') ==="
