/** Recover the country for stores the VPS labelled just "Africa" (→ landed country
 *  NULL) by mapping their PRIMARY store currency to its single owning country. A
 *  store based in ZAR is South African even on a .com domain — currency, not the
 *  TLD or a region label, identifies the merchant. Mirrors CCY_CC in sync-sheet.mjs.
 *
 *    node --env-file=.env.local scripts/backfill-country-from-currency.mjs [--apply]
 *
 *  Dry-run by default (prints what it WOULD set); pass --apply to write.
 */
import postgres from "postgres";

const CCY_CC = {
  ZAR: "ZA", NGN: "NG", KES: "KE", GHS: "GH", EGP: "EG", MAD: "MA", TND: "TN",
  DZD: "DZ", MZN: "MZ", TZS: "TZ", UGX: "UG", RWF: "RW", ZMW: "ZM", MUR: "MU",
  BWP: "BW", NAD: "NA", ETB: "ET", AOA: "AO", KWD: "KW", QAR: "QA", BHD: "BH",
  OMR: "OM", AED: "AE", ILS: "IL", TRY: "TR", JPY: "JP",
};
const APPLY = process.argv.includes("--apply");

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3 });
try {
  const rows = await sql`
    SELECT domain, UPPER(currency) ccy FROM imported_stores
    WHERE published AND country IS NULL AND currency IS NOT NULL AND currency <> ''`;
  const plan = rows
    .map((r) => ({ domain: r.domain, ccy: r.ccy, cc: CCY_CC[r.ccy] }))
    .filter((x) => x.cc);

  const byCC = {};
  for (const p of plan) byCC[p.cc] = (byCC[p.cc] || 0) + 1;
  console.log(`${rows.length} null-country stores have a currency; ${plan.length} map to a single country:`);
  console.log("  " + Object.entries(byCC).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join("  "));
  const skipped = rows.filter((r) => !CCY_CC[r.ccy]);
  if (skipped.length) console.log(`  (skipped ${skipped.length} ambiguous/non-specific: ${[...new Set(skipped.map((r) => r.ccy))].join(", ")})`);

  if (!APPLY) { console.log("\nDRY RUN — re-run with --apply to write."); }
  else {
    let n = 0;
    for (const p of plan) {
      await sql`UPDATE imported_stores SET country = ${p.cc} WHERE domain = ${p.domain} AND country IS NULL`;
      n++;
    }
    console.log(`\n✓ Applied: set country on ${n} stores.`);
  }
} finally { await sql.end(); }
