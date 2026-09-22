/** clean-storecensus-payments — StoreCensus's payment detection assumes the US Shopify stack, so
 *  in markets where Shopify Payments ISN'T offered it emits impossible gateways (e.g. 7.9k South
 *  African stores flagged shopify_payments, which SA merchants literally cannot run; plus Klarna/
 *  Affirm on "ZA" stores). That corrupts payment market-share for every non-US market.
 *
 *  Fix: for StoreCensus-sourced rows OUTSIDE the Shopify-Payments countries, strip the tokens that
 *  require Shopify Payments (shopify_payments, shop_pay) or don't exist there at all (klarna, affirm).
 *  If nothing real remains, reset the row (payments/source/checked_at NULL) so the checkout probe
 *  re-verifies it from the actual checkout. JP/US/EU StoreCensus data is untouched (valid there).
 *
 *    node --env-file=.env.local scripts/clean-storecensus-payments.mjs [--dry]
 */
import postgres from "postgres";

// ISO-2 countries where Shopify Payments is offered (so shopify_payments/shop_pay are legitimate).
const SP_COUNTRIES = new Set(["US","CA","GB","AU","NZ","IE","JP","SG","HK","AT","BE","CZ","DK","FI",
  "FR","DE","IT","NL","PT","ES","SE","CH","RO","BG","HR","CY","EE","GR","HU","LV","LT","LU","MT","PL","SK","SI"]);
// Tokens that can't be real outside those markets. The Shopify-native wallet bundle — shop_pay,
// apple_pay, google_pay — all route through Shopify Payments' express checkout, which isn't offered
// there; StoreCensus emits the whole bundle together (shop_pay|apple_pay|google_pay|shopify_payments).
// A genuine third-party wallet (via Peach/Stripe) is rare and our checkout probe re-finds it for real.
const IMPOSSIBLE = new Set(["shopify_payments", "shop_pay", "apple_pay", "google_pay", "klarna", "affirm"]);

const DRY = process.argv.includes("--dry");
const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 4, idle_timeout: 20 });
try {
  const rows = await sql`SELECT domain, country, payments FROM imported_stores
    WHERE payments_source = 'storecensus' AND payments IS NOT NULL AND payments <> ''
      AND (lower(payments) LIKE '%shopify_payments%' OR lower(payments) LIKE '%shop_pay%'
           OR lower(payments) LIKE '%apple_pay%' OR lower(payments) LIKE '%google_pay%'
           OR lower(payments) LIKE '%klarna%' OR lower(payments) LIKE '%affirm%')`;
  let stripped = 0, reset = 0, skipped = 0;
  const upd = [];
  for (const r of rows) {
    if (SP_COUNTRIES.has((r.country || "").toUpperCase())) { skipped++; continue; } // valid there
    const toks = r.payments.split(/[;|]/).map((t) => t.trim()).filter(Boolean);
    const kept = toks.filter((t) => !IMPOSSIBLE.has(t.toLowerCase()));
    if (kept.length === toks.length) { skipped++; continue; }
    if (kept.length) { upd.push({ domain: r.domain, payments: kept.join(";"), reset: false }); stripped++; }
    else { upd.push({ domain: r.domain, payments: null, reset: true }); reset++; }
  }
  console.log(`StoreCensus non-Shopify-Payments rows carrying an impossible gateway: ${rows.length.toLocaleString()}`);
  console.log(`  → strip impossible tokens (keep the rest): ${stripped.toLocaleString()}`);
  console.log(`  → nothing real left, reset for re-probe:  ${reset.toLocaleString()}`);
  console.log(`  → untouched (Shopify-Payments country / no change): ${skipped.toLocaleString()}`);
  if (DRY) { console.log("(dry run — no writes)"); }
  else {
    for (let i = 0; i < upd.length; i += 500) {
      await Promise.all(upd.slice(i, i + 500).map((u) =>
        u.reset
          ? sql`UPDATE imported_stores SET payments = NULL, payments_source = NULL, payments_checked_at = NULL WHERE domain = ${u.domain}`
          : sql`UPDATE imported_stores SET payments = ${u.payments} WHERE domain = ${u.domain}`));
    }
    console.log(`Applied ${upd.length.toLocaleString()} updates.`);
  }
} finally { await sql.end(); }
