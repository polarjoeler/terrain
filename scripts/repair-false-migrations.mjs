#!/usr/bin/env node
/**
 * Undo the false "migrated" verdicts, where a Shopify-only liveness probe met a non-Shopify store.
 *
 *   node --env-file=.env.local scripts/repair-false-migrations.mjs            # dry run
 *   node --env-file=.env.local scripts/repair-false-migrations.mjs --write
 *
 * verify-liveness.mjs tests liveness with /products.json, which only Shopify serves. A WooCommerce
 * store therefore reads as "reachable, not Shopify, platform identified = WooCommerce" and was
 * marked `migrated` even though its recorded platform was ALREADY WooCommerce. Two consequences:
 *   - a fake churn_log row, with historic=false, so it counted as period churn; and
 *   - the store dropped out of the customer-visible base, since lib/browse.ts excludes
 *     live_status IN ('dead','migrated').
 *
 * A false verdict is identified structurally — `live_platform` equals the recorded `platform` — so
 * this touches nothing where the platform genuinely changed. Genuine migrations (13,792 of the
 * 13,833 'migrated' rows when this was written) are left alone.
 *
 * Restores live_status to 'active': these stores were REACHABLE at the time of the check, which is
 * what the probe did establish. live_miss is reset so they don't sit one miss from re-churning.
 */
import postgres from "postgres";

const WRITE = process.argv.includes("--write");
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set (run with --env-file=.env.local)");
  process.exit(2);
}
const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 20 });

const stores = await sql`
  SELECT domain, platform, live_platform, country, published FROM imported_stores
  WHERE live_status = 'migrated'
    AND live_platform IS NOT NULL AND platform IS NOT NULL
    AND lower(platform) = lower(live_platform)
  ORDER BY domain`;

const churn = await sql`
  SELECT c.domain, c.migrated_to, c.historic FROM churn_log c JOIN imported_stores s USING (domain)
  WHERE c.status = 'migrated' AND s.platform IS NOT NULL AND c.migrated_to IS NOT NULL
    AND lower(s.platform) = lower(c.migrated_to)
  ORDER BY c.domain`;

console.log(`stores falsely marked migrated : ${stores.length}`);
const byPlat = {};
for (const r of stores) byPlat[r.platform] = (byPlat[r.platform] ?? 0) + 1;
for (const [k, v] of Object.entries(byPlat).sort((a, b) => b[1] - a[1])) console.log(`    ${String(k).padEnd(14)} ${v}`);
console.log(`fake churn_log rows            : ${churn.length}`);
console.log(`  of which historic=false (counted as real churn): ${churn.filter((r) => r.historic === false).length}`);

if (!WRITE) {
  console.log("\nDry run — nothing written. Re-run with --write to repair.");
  await sql.end();
  process.exit(0);
}

const fixed = await sql`
  UPDATE imported_stores SET live_status = 'active', live_miss = 0
  WHERE live_status = 'migrated'
    AND live_platform IS NOT NULL AND platform IS NOT NULL
    AND lower(platform) = lower(live_platform)
  RETURNING domain`;
console.log(`\nrestored to active : ${fixed.length}`);

const removed = await sql`
  DELETE FROM churn_log c USING imported_stores s
  WHERE c.domain = s.domain AND c.status = 'migrated'
    AND s.platform IS NOT NULL AND c.migrated_to IS NOT NULL
    AND lower(s.platform) = lower(c.migrated_to)
  RETURNING c.domain`;
console.log(`fake churn rows removed: ${removed.length}`);
await sql.end();
