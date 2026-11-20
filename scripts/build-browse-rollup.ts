/**
 * Rebuild the browse summary table (browse_rollup) — every Explorer count and facet, per country ×
 * platform, so the dashboard sums a few hundred rows instead of scanning every visible store.
 * See lib/browse.ts (buildBrowseRollup / rollupAgg).
 *
 *   npx tsx --env-file=.env.local scripts/build-browse-rollup.ts              # visible markets (hourly)
 *   npx tsx --env-file=.env.local scripts/build-browse-rollup.ts --migrate    # create the tables first
 *   npx tsx --env-file=.env.local scripts/build-browse-rollup.ts --countries US,UK,AU   # precompute more
 *   npx tsx --env-file=.env.local scripts/build-browse-rollup.ts --all        # every country (sizing test)
 *   npx tsx --env-file=.env.local scripts/build-browse-rollup.ts --check ZA,KE  # read-only correctness check
 */
import { buildBrowseRollup, checkRollupCountry, migrateBrowseRollup } from "../lib/browse.ts";
import { db } from "../lib/db";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : undefined; };
async function main() {
  const check = arg("--check");   // read-only: compare one country's summary counts with direct counts
  if (check) {
    for (const c of check.split(",")) {
      const t = Date.now();
      const r = await checkRollupCountry(c.trim());
      console.log(`${c}: ${r.checked} counts compared · ${r.mismatches.length} mismatches · ${((Date.now() - t) / 1000).toFixed(1)}s`);
      for (const m of r.mismatches.slice(0, 10)) console.log("   " + m);
    }
    await db().end(); return;
  }
  if (process.argv.includes("--migrate")) { await migrateBrowseRollup(); console.log("tables ready"); }
  let countries = arg("--countries")?.split(",").map((s) => s.trim()).filter(Boolean);
  if (process.argv.includes("--all")) {
    countries = (await db()<{ country: string }[]>`
      SELECT DISTINCT country FROM imported_stores
      WHERE published AND activity_tier IS DISTINCT FROM 'not_a_store' AND country IS NOT NULL AND country <> ''`).map((r) => r.country);
  }
  const r = await buildBrowseRollup({ countries, bucketRows: Number(arg("--bucket-rows") ?? 120_000), log: (m) => console.log("  " + m) });
  console.log(`build ${r.build}: ${r.partitions} partitions · ${r.rows.toLocaleString()} rows · ${r.seconds}s`);
  await db().end();
}
main().catch(async (e) => { console.error("build-browse-rollup failed:", e.message); await db().end().catch(() => {}); process.exit(1); });
