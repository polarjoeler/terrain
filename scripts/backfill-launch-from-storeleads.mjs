/** Backfill launch date from StoreLeads' store creation date, at MONTH precision.
 *  first_product_at (own-sourced earliest product publish) only covers ~3%, so most
 *  older stores had no launch date. StoreLeads gives a `created` date on every
 *  imported store (landed in store_created); month/year is precise enough as a launch
 *  proxy for older stores. Fills launched_at ONLY where it's NULL, so the more precise
 *  own-sourced 'earliest_product' dates are never overwritten.
 *
 *    node --env-file=.env.local scripts/backfill-launch-from-storeleads.mjs [--apply]
 */
import postgres from "postgres";

const APPLY = process.argv.includes("--apply");
// Longer connect_timeout + single connection: under the SentinelOne network stall,
// connects are slow/flaky, so give each attempt a wide window and only need ONE.
const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1, connect_timeout: 45 });
try {
  if (!APPLY) {
    const [before] = await sql`SELECT COUNT(launched_at)::int la, COUNT(*)::int tot FROM imported_stores WHERE published`;
    const [cand] = await sql`
      SELECT COUNT(*)::int n FROM imported_stores
      WHERE published AND launched_at IS NULL AND store_created IS NOT NULL`;
    console.log(`launched_at now: ${before.la}/${before.tot}.  Fillable from store_created (month precision): ${cand.n}`);
    console.log("\nDRY RUN — re-run with --apply to write.");
  } else {
    // The ESSENTIAL statement runs FIRST and alone — idempotent (fills only NULLs), so a
    // retry that lands here has done the job even if the follow-up count times out.
    // date_trunc → first of month = month/year precision; provenance tagged explicitly.
    const res = await sql`
      UPDATE imported_stores
         SET launched_at = date_trunc('month', store_created)::date,
             launched_source = 'storeleads_created'
       WHERE published AND launched_at IS NULL AND store_created IS NOT NULL`;
    console.log(`✓ Applied: filled ${res.count}.`);
    try {
      const [after] = await sql`SELECT COUNT(launched_at)::int la, COUNT(*)::int tot FROM imported_stores WHERE published`;
      console.log(`launched_at now: ${after.la}/${after.tot} (${Math.round(100 * after.la / after.tot)}%).`);
    } catch { /* count is best-effort; the write above already landed */ }
  }
} finally { await sql.end(); }
