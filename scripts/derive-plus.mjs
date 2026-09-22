/** derive-plus — recompute the CONFIDENT Shopify Plus flag + cap implausible sales.
 *
 *  Why: the raw plan signal (StoreCensus `latest_shopify_plan`, and our old HTML heuristic) is
 *  inflated by post-Checkout-Extensibility false positives — Shopify shipped checkout-ui-extensions
 *  / checkout tokens to ALL tiers in 2023-24, so the fingerprints that were once Plus-exclusive now
 *  fire on basic stores. Raw plan='plus' was ~3,611; most are small stores no merchant would run on
 *  Plus (~$2.3k/mo). So we treat plan as a NOISY signal and only mark `plus=true` when it's credible.
 *
 *  Confident Plus = (flagged plan AND a revenue floor that makes Plus economically rational)
 *                   OR an independent STRONG Plus-only fingerprint from our checkout probe
 *                      (multipass / shopify-plus badge / checkout.shopifycs.com → plus_signal='strong').
 *  Raw plan='plus' stays queryable as "possible Plus" for a lower-confidence view.
 *
 *    node --env-file=.env.local scripts/derive-plus.mjs
 */
import postgres from "postgres";

const SALES_CEILING = 20_000_000; // $/mo — no single Shopify store does more; higher = misparsed/annual
const PLUS_SALES_FLOOR = 50_000;  // $/mo — below this, paying Plus's ~$2.3k/mo fee is irrational

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3, idle_timeout: 20 });
try {
  // 0. the probe-fingerprint column (populated by sync-checkout-payments from the checkout probe).
  await sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS plus_signal TEXT`;

  // 1. cap implausibly-high monthly sales (misparsed / annual / cumulative). Cap rather than NULL so
  //    the store still ranks as large and still clears the Plus floor — we just drop the fake magnitude.
  const capped = await sql`
    UPDATE imported_stores SET estimated_monthly_sales = ${SALES_CEILING}
    WHERE lower(platform) = 'shopify' AND estimated_monthly_sales > ${SALES_CEILING}`;

  // 2. confident Plus flag.
  const r = await sql`
    UPDATE imported_stores SET plus = (
        (lower(plan) IN ('plus', 'shopify plus') AND COALESCE(estimated_monthly_sales, 0) >= ${PLUS_SALES_FLOOR})
        OR plus_signal = 'strong'
      )
    WHERE lower(platform) = 'shopify'`;

  const [c] = await sql`
    SELECT
      count(*) FILTER (WHERE plus)::int confirmed,
      count(*) FILTER (WHERE plus AND plus_signal = 'strong')::int by_fingerprint,
      count(*) FILTER (WHERE lower(plan) IN ('plus','shopify plus'))::int possible
    FROM imported_stores WHERE published AND lower(platform) = 'shopify'`;
  console.log(`capped ${capped.count} sales outlier(s) at $${SALES_CEILING.toLocaleString()}/mo.`);
  console.log(`Confident Plus (plus=true): ${c.confirmed.toLocaleString()} (${c.by_fingerprint} via independent probe fingerprint).`);
  console.log(`Possible Plus (raw plan='plus', lower confidence): ${c.possible.toLocaleString()}.`);
} finally { await sql.end(); }
