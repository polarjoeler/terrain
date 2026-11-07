/** stamp-shopify-checkout-payments — make payments provenance explicit instead of implied.
 *
 *  The Shopify checkout probe has always written `payments` and left `payments_source` NULL, so
 *  NULL has quietly meant "our Shopify checkout probe" rather than "unknown". That convention is
 *  real and already load-bearing — snapshot-providers.mjs encodes it as
 *  `isProbeVerified = payments_source !== 'storecensus'` — but it is invisible to anything reading
 *  the column directly, and it reads as a provenance gap to anyone auditing the table.
 *
 *  It is safe to make explicit because nothing can produce unstamped payment data except that
 *  probe: import-storecensus.mjs ties payments and payments_source in one ternary (it cannot write
 *  one without the other), and import-storeleads.mjs never touches payments at all. Nothing keys
 *  off `payments_source IS NULL` as a work queue, so stamping starves no lane.
 *
 *  This matters for anything that sells or redistributes payment data — see
 *  DESIGN-mcp-server.md — where "ours" has to be expressible as a filter rather than a comment.
 *
 *  Pure DB work: no probing, no network, no residential-IP budget.
 *
 *    node --env-file=.env.local scripts/stamp-shopify-checkout-payments.mjs [--commit]
 */
import postgres from "postgres";

const SRC = "shopify_checkout";
const BATCH = 2000;
const COMMIT = process.argv.includes("--commit");

// Per-connection timeouts: a wedged statement on this table is how the whole table (and the
// dashboard) froze before. Batched updates, never one unbounded statement.
const sql = postgres(process.env.DATABASE_URL, {
  prepare: false,
  max: 2,
  idle_timeout: 20,
  connection: { statement_timeout: "60s", idle_in_transaction_session_timeout: "60s" },
});

const pending = () => sql`
  SELECT count(*)::int AS n FROM imported_stores
  WHERE payments IS NOT NULL AND btrim(payments) <> '' AND payments_source IS NULL`;

try {
  const [{ n: total }] = await pending();
  const [{ n: visible }] = await sql`
    SELECT count(*)::int AS n FROM imported_stores
    WHERE payments IS NOT NULL AND btrim(payments) <> '' AND payments_source IS NULL
      AND published = true AND country IN ('ZA','KE','NG')`;

  console.log(`Unstamped rows carrying payment data: ${total.toLocaleString()} (${visible.toLocaleString()} in ZA/KE/NG)`);
  console.log(`Would set payments_source = '${SRC}'. payments and payments_checked_at are untouched.`);

  if (!COMMIT) {
    console.log("\nDRY RUN — nothing written. Re-run with --commit.");
    await sql.end();
    process.exit(0);
  }

  let done = 0;
  for (;;) {
    const rows = await sql`
      UPDATE imported_stores SET payments_source = ${SRC}
      WHERE domain IN (
        SELECT domain FROM imported_stores
        WHERE payments IS NOT NULL AND btrim(payments) <> '' AND payments_source IS NULL
        LIMIT ${BATCH}
      )
      RETURNING domain`;
    if (rows.length === 0) break;
    done += rows.length;
    console.log(`  stamped ${done.toLocaleString()} / ${total.toLocaleString()}`);
  }

  const [{ n: left }] = await pending();
  console.log(`\nDone. Stamped ${done.toLocaleString()}; ${left.toLocaleString()} unstamped remain (expected 0).`);
} finally {
  await sql.end();
}
