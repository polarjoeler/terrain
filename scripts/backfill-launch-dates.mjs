#!/usr/bin/env node
// Backfill launched_at from the TLS cert issuance date (cert_not_before) we already capture, for
// the ~503k ct_tail/vps_ct rows that have a cert date but no launch date.
//
// WHY sound despite "a cert renewal resets notBefore": measured 2026-10-29 on 544,854 ct_tail rows
// carrying both a cert date and a discovery date, 73% have cert_not_before within 30 days of first
// discovery and only 32 rows (0.006%) show the "old store, late renewal we caught" pattern. We tail
// CT continuously, so for OUR discoveries the cert date is a reliable launch proxy.
//
// Uses the EXISTING launched_source column (vocabulary already in use: storecensus / wp_oldest /
// earliest_product / storeleads_created / cert) — 'cert' is an established value, so this just
// scales it up. Only fills rows where launched_at IS NULL, so a precise import/product date always
// wins. No DDL (the column exists); batched by ctid to keep each statement pooler-timeout safe.
//
// Run:  node --env-file=.env.local scripts/backfill-launch-dates.mjs
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL || process.env.POSTGRES_URL, { ssl: "require", max: 2 });
const FLOOR = "2015-01-01"; // africa-timeline.ts floor: older launch dates are sparse/garbage.

try {
  let total = 0, pass = 0;
  for (;;) {
    const res = await sql`
      WITH batch AS (
        SELECT ctid FROM imported_stores
        WHERE launched_at IS NULL AND cert_not_before BETWEEN ${FLOOR}::date AND CURRENT_DATE
        LIMIT 20000
      )
      UPDATE imported_stores t SET launched_at = t.cert_not_before, launched_source = 'cert'
      FROM batch WHERE t.ctid = batch.ctid`;
    total += res.count; pass++;
    console.log(`  pass ${pass}: +${res.count} (total ${total})`);
    if (res.count === 0) break;
  }
  console.log("cert-derived launch dates backfilled:", total);

  const [v] = await sql`SELECT
    count(*) FILTER (WHERE launched_at >= CURRENT_DATE - 30)                                               AS launched_30d,
    count(*) FILTER (WHERE launched_at >= CURRENT_DATE - 30 AND launched_source='cert')                    AS launched_30d_cert,
    count(*) FILTER (WHERE launched_at >= CURRENT_DATE - 30 AND country IN ('ZA','KE','NG') AND published) AS launched_30d_focus_pub
    FROM imported_stores`;
  console.log("\nAFTER — launched in last 30d:", v);
} catch (e) {
  console.error("ERR", e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
