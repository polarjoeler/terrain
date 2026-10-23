/** derive-plan-tier — place every Shopify store on a PLAN LADDER, not a plus/not-plus flag.
 *
 *  Why a ladder and not a label: Shopify exposes no plan field publicly. Basic vs Grow is
 *  invisible from outside (nothing Grow unlocks leaves a storefront footprint), so a true
 *  4-tier label is unreachable. What IS reachable is a set of documented ELIGIBILITY FLOORS
 *  — features Shopify only sells above a given plan, which we can see a store using:
 *
 *    exact (basic|grow|advanced|plus|…)  a leaked admin config gave us the literal plan.
 *                                        Ground truth. ~0.5% of probed checkouts, free.
 *    plus                                confident Plus (plan+revenue, or our Plus-exclusive
 *                                        checkout fingerprint — see derive-plus.mjs).
 *    advanced_or_annual                  the store runs third-party CALCULATED shipping rates
 *                                        at checkout. Shopify's CarrierService API requires
 *                                        "the Advanced plan or higher", or "the Shopify plan
 *                                        with yearly billing / the feature added for a monthly
 *                                        fee" (also dev stores). So: NOT Basic-monthly.
 *    not_plus                            probed, rates render, no floor cleared. Deliberately
 *                                        NOT called "basic": we only know it isn't Plus.
 *    null                                never probed — unknown.
 *
 *  The vendor `plan` column is NOT used here. Measured against the 13 stores whose exact plan
 *  leaked, vendor plan called 4/4 Grow stores "basic" and 2/2 Plus stores "basic" — it encodes
 *  "not known to be Plus", carrying no Basic-vs-Grow information at all.
 *
 *    node --env-file=.env.local scripts/derive-plan-tier.mjs [--write]
 *  Defaults to a DRY RUN (prints the distribution, writes nothing).
 */
import postgres from "postgres";

const WRITE = process.argv.includes("--write");

// Rate `source` values that are Shopify's own machinery, not a third-party carrier service.
const NATIVE = ["shopify", "shopify_provided_generic_layer"];
// Bare carrier names: ambiguous, because Shopify Shipping shows carrier-calculated rates on
// EVERY plan — but only to stores located where Shopify Shipping is sold. Outside that list a
// bare carrier rate must come from the merchant's own connected carrier account, which is the
// same Advanced-or-annual gate.
const BARE = ["usps", "ups", "ups_shipping", "dhl_express", "dhl_ecommerce", "dhl commerce",
  "fedex", "canada_post", "purolator", "australia_post", "royal_mail", "sendle"];
const SHOPIFY_SHIPPING_COUNTRIES = ["US", "CA", "AU", "GB", "UK", "IE", "FR", "DE", "IT", "ES",
  "NL", "AT", "BE", "DK", "SE"];

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3, idle_timeout: 20 });
try {
  if (WRITE) {
    // ADD COLUMN takes ACCESS EXCLUSIVE — a blocked ALTER queues behind it and stalls the
    // whole discovery pipeline. Fail fast instead of holding the table hostage.
    await sql`SET lock_timeout = '4s'`;
    await sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS plan_tier TEXT`;
    await sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS plan_tier_basis TEXT`;
  }

  // plan_exact is created by sync-checkout-payments on its next run; tolerate its absence so
  // a dry run works before the first sync.
  const [{ has }] = await sql`
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_name = 'imported_stores' AND column_name = 'plan_exact') AS has`;
  const planExact = has ? sql`btrim(s.plan_exact)` : sql`NULL::text`;
  if (!has) console.log("note: plan_exact column not present yet — exact rung reads as empty.\n");

  const thirdParty = sql`EXISTS (
    SELECT 1 FROM unnest(string_to_array(s.shipping_providers, ';')) t
    WHERE btrim(t) <> '' AND lower(btrim(t)) <> ALL(${NATIVE}::text[])
                         AND lower(btrim(t)) <> ALL(${BARE}::text[]))`;
  const bareCarrier = sql`EXISTS (
    SELECT 1 FROM unnest(string_to_array(s.shipping_providers, ';')) t
    WHERE lower(btrim(t)) = ANY(${BARE}::text[]))`;
  const outsideShipping = sql`upper(COALESCE(s.country, '')) <> ALL(${SHOPIFY_SHIPPING_COUNTRIES}::text[])`;

  const tier = sql`CASE
      WHEN COALESCE(${planExact}, '') <> '' THEN ${planExact}
      WHEN s.plus THEN 'plus'
      WHEN ${thirdParty} THEN 'advanced_or_annual'
      WHEN ${outsideShipping} AND ${bareCarrier} THEN 'advanced_or_annual'
      WHEN s.payments_checked_at IS NOT NULL THEN 'not_plus'
      ELSE NULL END`;
  const basis = sql`CASE
      WHEN COALESCE(${planExact}, '') <> '' THEN 'leaked_admin_config'
      WHEN s.plus THEN COALESCE(NULLIF(s.plus_signal, ''), 'plan_and_revenue')
      WHEN ${thirdParty} THEN 'carrier_service_app'
      WHEN ${outsideShipping} AND ${bareCarrier} THEN 'carrier_account_outside_shopify_shipping'
      WHEN s.payments_checked_at IS NOT NULL THEN 'probed_native_rates_only'
      ELSE NULL END`;

  const where = sql`s.published AND lower(s.platform) = 'shopify'`;

  if (WRITE) {
    // Guarded so an unchanged row is not rewritten every run (dead-tuple churn on 1M rows).
    const r = await sql`
      UPDATE imported_stores s SET plan_tier = ${tier}, plan_tier_basis = ${basis}
      WHERE ${where} AND (plan_tier IS DISTINCT FROM (${tier})
                          OR plan_tier_basis IS DISTINCT FROM (${basis}))`;
    console.log(`wrote plan_tier on ${r.count.toLocaleString()} row(s).\n`);
  } else {
    console.log("DRY RUN — no writes. Re-run with --write to persist.\n");
  }

  const dist = await sql`
    SELECT COALESCE(${tier}, '(unprobed)') AS plan_tier, ${basis} AS basis, count(*)::int n
    FROM imported_stores s WHERE ${where}
    GROUP BY 1, 2 ORDER BY n DESC`;
  console.log("PLAN LADDER:"); console.table(dist);

  // Does a floor we DERIVED agree with the exact plan where we have both? The only honest
  // accuracy check available — tiny n, but it is real ground truth.
  const val = await sql`
    SELECT ${planExact} AS exact_plan,
           count(*)::int n,
           count(*) FILTER (WHERE s.plus)::int we_called_plus,
           count(*) FILTER (WHERE ${thirdParty} OR (${outsideShipping} AND ${bareCarrier}))::int cleared_carrier_gate
    FROM imported_stores s
    WHERE ${where} AND COALESCE(${planExact}, '') <> ''
    GROUP BY 1 ORDER BY n DESC`;
  console.log("VALIDATION vs leaked ground truth:"); console.table(val);
} finally { await sql.end(); }
