#!/usr/bin/env node
/**
 * Heal the platform of stores we already know have moved, so they become leads again.
 *
 *   node --env-file=.env.local scripts/backfill-migrations.mjs            # dry run
 *   node --env-file=.env.local scripts/backfill-migrations.mjs --write
 *
 * Before migrated_from/migrated_at existed, a confirmed move left the store as
 * live_status='migrated' with its OLD platform still in `platform` and the new one in
 * `live_platform`. lib/browse.ts excludes the terminal states, so every one of those stores is
 * invisible to customers — we detected the single most commercially interesting moment in a
 * store's life and then removed it from the product.
 *
 * This converts them to the shape verify-liveness.mjs now writes directly:
 *   migrated_from = platform (where it was)      platform = live_platform (where it is)
 *   migrated_at   = last_alive_at (when it left) live_status = 'active' (it is trading)
 *
 * SCOPE, measured 2026-11-13 — much smaller than "13,833 migrated stores" suggests:
 *   13,833  live_status='migrated'
 *   12,284  have NO destination platform recorded — we know they left, not where they went, so
 *           they CANNOT be healed. That is 89% of our migration history, and worth its own look.
 *       41  destination == platform: the false verdicts from the Shopify-only probe. Run
 *           scripts/repair-false-migrations.mjs first; the WHERE here skips them anyway.
 *    1,508  healable, of which just 98 are published in a customer-visible market (51 in ZA).
 *
 * So the effect on headline numbers is 98 stores against a 116,750 live base — 0.08%. It is not a
 * metrics event. It does still shift PLAN scope for those rows: a store healed to WooCommerce
 * leaves a Shopify-only plan's visibility and becomes Partner-only, which is correct.
 *
 * One honest limitation: only 1 of the 1,508 has a last_alive_at, so for backfilled rows
 * migrated_at falls back to live_checked_at — WHEN WE NOTICED, not when the store moved. Only
 * migrations recorded from now on get the real estimate. Treat backfilled dates as upper bounds.
 *
 * churn_log rows are left untouched: leaving a platform IS churn for that platform, and that
 * history stands.
 *
 * Only rows where live_platform is present and genuinely DIFFERS from platform are touched, so the
 * false "migrations" fixed in the Shopify-only-probe change are not resurrected here — run
 * scripts/repair-false-migrations.mjs first and this will skip them.
 */
import postgres from "postgres";

const WRITE = process.argv.includes("--write");
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set (run with --env-file=.env.local)");
  process.exit(2);
}
const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 30 });

const WHERE = sql`
  live_status = 'migrated'
  AND live_platform IS NOT NULL
  AND lower(live_platform) <> lower(COALESCE(platform, 'shopify'))
  AND migrated_from IS NULL`;

const [c] = await sql`SELECT count(*) AS n,
  count(*) FILTER (WHERE published) AS pub,
  count(*) FILTER (WHERE last_alive_at IS NOT NULL) AS datable
  FROM imported_stores WHERE ${WHERE}`;
console.log(`stores to heal: ${Number(c.n).toLocaleString()}  (${Number(c.pub).toLocaleString()} published, ${Number(c.datable).toLocaleString()} with a datable move)`);

const flows = await sql`
  SELECT lower(COALESCE(platform,'shopify')) AS from_p, lower(live_platform) AS to_p, count(*) AS n
  FROM imported_stores WHERE ${WHERE} GROUP BY 1,2 ORDER BY n DESC LIMIT 10`;
console.log(`\ntop flows being restored:`);
for (const r of flows) console.log(`  ${String(r.from_p).padEnd(14)} -> ${String(r.to_p).padEnd(14)} ${String(r.n).padStart(6)}`);

const mkts = await sql`
  SELECT country, count(*) AS n FROM imported_stores
  WHERE ${WHERE} AND published GROUP BY 1 ORDER BY n DESC LIMIT 8`;
console.log(`\npublished, by market (these re-enter the customer-visible base):`);
for (const r of mkts) console.log(`  ${String(r.country ?? "(null)").padEnd(6)} ${String(r.n).padStart(6)}`);

if (!WRITE) {
  console.log("\nDry run — nothing written. Re-run with --write once you have decided the counts should move.");
  await sql.end();
  process.exit(0);
}

const done = await sql`
  UPDATE imported_stores SET
    migrated_from = platform,
    migrated_at = COALESCE(last_alive_at, live_checked_at),
    platform = live_platform,
    live_status = 'active',
    live_miss = 0
  WHERE ${WHERE}
  RETURNING domain`;
console.log(`\nhealed: ${done.length.toLocaleString()} stores`);
await sql.end();
