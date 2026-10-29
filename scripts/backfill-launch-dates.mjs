#!/usr/bin/env node
// Backfill launched_at from the TLS cert issuance date (cert_not_before) we already capture.
//
// WHY this is sound despite the "a cert renewal resets notBefore" caveat that originally kept
// cert_not_before OUT of launched_at: measured 2026-10-29 on 544,854 ct_tail rows that carry both
// a cert date and a discovery date, 73% have cert_not_before within 30 days of when we first saw
// the domain in CT, and only 32 rows (0.006%) show the "old store, late renewal we happened to
// catch" pattern (cert >180d older than discovery). Because we tail CT continuously we catch certs
// essentially at issuance, so for OUR discoveries the cert date is a reliable launch proxy.
//
// Honesty guardrail: launched_at_source distinguishes a cert ESTIMATE from a precise import date,
// so nothing downstream mistakes one for the other. ON CONFLICT in the landers keeps the EARLIEST
// cert (COALESCE), so a later renewal never moves an existing launch date.
//
// Run:  node --env-file=.env.local scripts/backfill-launch-dates.mjs
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL || process.env.POSTGRES_URL, { ssl: "require", max: 2 });
const FLOOR = "2015-01-01"; // africa-timeline.ts floor: older launch dates are sparse/garbage.

try {
  // 1. launched_at_source column (metadata-only ADD COLUMN; short lock_timeout per the
  //    schema-check-lock lesson — never let DDL sit on an ACCESS EXCLUSIVE lock).
  await sql`SET lock_timeout = '3s'`;
  const [hasCol] = await sql`SELECT 1 FROM information_schema.columns
    WHERE table_name='imported_stores' AND column_name='launched_at_source'`;
  if (!hasCol) { await sql`ALTER TABLE imported_stores ADD COLUMN launched_at_source text`; console.log("added launched_at_source"); }
  else console.log("launched_at_source already exists");

  // 2. Tag existing precise launch dates (from imports / first_product) so cert estimates stay
  //    distinguishable. Done before the cert backfill so these never get mislabeled 'cert'.
  const tagged = await sql`UPDATE imported_stores SET launched_at_source='import'
    WHERE launched_at IS NOT NULL AND launched_at_source IS NULL`;
  console.log("tagged existing precise launch dates as 'import':", tagged.count);

  // 3. Cert-derived launch dates, batched by ctid to keep each statement small (pooler-timeout safe).
  let total = 0, pass = 0;
  for (;;) {
    const res = await sql`
      WITH batch AS (
        SELECT ctid FROM imported_stores
        WHERE launched_at IS NULL AND cert_not_before BETWEEN ${FLOOR}::date AND CURRENT_DATE
        LIMIT 20000
      )
      UPDATE imported_stores t SET launched_at = t.cert_not_before, launched_at_source='cert'
      FROM batch WHERE t.ctid = batch.ctid`;
    total += res.count; pass++;
    console.log(`  pass ${pass}: +${res.count} (total ${total})`);
    if (res.count === 0) break;
  }
  console.log("cert-derived launch dates backfilled:", total);

  // 4. Verify the headline metric moved off zero.
  const [v] = await sql`SELECT
    count(*) FILTER (WHERE launched_at >= CURRENT_DATE - 30)                                                          AS launched_30d,
    count(*) FILTER (WHERE launched_at >= CURRENT_DATE - 30 AND launched_at_source='cert')                            AS launched_30d_cert,
    count(*) FILTER (WHERE launched_at >= CURRENT_DATE - 30 AND country IN ('ZA','KE','NG') AND published)            AS launched_30d_focus_pub
    FROM imported_stores`;
  console.log("\nAFTER — launched in last 30d:", v);
} catch (e) {
  console.error("ERR", e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
