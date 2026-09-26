#!/bin/bash
# Scheduled country-retag. The mislabel fix is NOT one-and-done: discovery keeps re-tagging
# international Shopify-Payments stores as African (Shopify Payments can't run in Africa), so the
# ZA count creeps back up (1,657 → 1,774 in a day) unless we sweep regularly. This wrapper runs the
# retag and then busts the insights aggregate caches so the corrected country data surfaces on the
# next page load instead of waiting out the cache TTL.
#
#   Driven by ~/Library/LaunchAgents/com.tembo.retag.plist (daily + RunAtLoad).
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

echo "===== retag $(date '+%F %T') ====="
node --env-file=.env.local scripts/retag-mislabeled-country.mjs || { echo "!! retag failed"; exit 1; }

# Invalidate the shared aggregate caches whose inputs the retag changed (per-country insights
# reports, the adoption chart, the country list, the Africa timeline, coverage). They recompute
# fresh (stale-while-revalidate) on the next request.
echo "--- busting insights caches ---"
node --env-file=.env.local -e '
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { prepare:false, max:1, connection:{ statement_timeout:30000 } });
try {
  const r = await sql`DELETE FROM agg_cache WHERE key LIKE ${"insights:%"} OR key LIKE ${"africa:%"} OR key LIKE ${"coverage:%"} RETURNING 1`;
  console.log(`cleared ${r.length} agg_cache rows`);
} catch (e) { console.log("cache bust skipped:", e.message); }
await sql.end();
' || echo "!! cache bust failed (non-fatal)"
echo "===== retag done $(date '+%T') ====="
