/** import-storecensus — upsert rich StoreCensus NDJSON exports (from the dashboard API pull)
 *  into imported_stores. One JSON object per line.
 *
 *  WIDE SHAPE (2026-10-18). The API returns 129 fields; we were keeping 35 and discarding the rest,
 *  including `apps`, `social_media`, `technology`, `latest_product_count` and `latest_avg_price` —
 *  i.e. things we were separately PROBING for at real cost. The puller now extracts them. Note the
 *  raw `apps` field carries full per-app install history and averages 41 KB/row, so the browser
 *  flattens it to names before download (51 KB/row -> 1.4 KB/row).
 *    {platform,country,d,s,city,state,zip,theme,created,first,plan,cur,traffic,vert,pays,
 *     apps[],tech[],ig,fb,tw,yt,li,pin,tiktok,prod,variants,avgprice,company,lang,pw,
 *     techspend,ckext,reviews,employees,g7,g30}
 *
 *  EVERY field is written with COALESCE(existing, incoming): our OWN probe data always wins. That
 *  matters most for `payments` (ours is checkout-verified; StoreCensus assumes the US Shopify stack)
 *  and for apps/technologies/socials from deep-enrich.
 *  Fills gaps only (COALESCE) so it never clobbers better existing data. Published as leads
 *  (platform is known + paid source); run source-liveness.mjs afterwards to confirm liveness.
 *
 *    node --env-file=.env.local scripts/import-storecensus.mjs /path/sc_jp_shopify.ndjson
 *    node --env-file=.env.local scripts/import-storecensus.mjs /path/x.ndjson --unpublished
 *
 *  --unpublished lands rows published=false. REQUIRED for any batch whose country is not yet
 *  confirmed: an unplaceable row published as a lead pollutes the insights counts, the browse
 *  snapshot top-N cut and the launch floor. Re-derive country, then promote.
 *    node --env-file=.env.local scripts/source-liveness.mjs --source storecensus --country JP
 */
import postgres from "postgres";
import { readFileSync } from "fs";
import { createInterface } from "readline";
import { createReadStream } from "fs";

const isoDate = (s) => {
  if (!s || typeof s !== "string") return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
};
// StoreCensus `website_created_at` is DOMAIN registration age, not the Shopify launch — a weak
// proxy that predates Shopify for migrated domains (1996 outliers). Only trust it as a launch
// signal in the Shopify era (>=2015); cert-based dating remains authoritative when present.
const launchFrom = (s) => { const d = isoDate(s); return d && d >= "2015-01-01" ? d : null; };
const num = (v) => (v === "" || v == null || isNaN(+v) ? null : +v);
// The puller already flattens apps/technology to name arrays; store them in the existing
// pipe-delimited text columns so every reader (payments-taxonomy, insights, the drawer) keeps working.
// StoreCensus sometimes returns a FLOAT where the column is INTEGER (estimated_visits came back as
// 204734.78 on 6 of 75,000 rows), which Postgres rejects outright and fails the whole batch.
const int = (v) => { const n = num(v); return n == null ? null : Math.min(Math.max(Math.round(n), -2147483648), 2147483647); };
const list = (v) => (Array.isArray(v) && v.length ? [...new Set(v.filter(Boolean))].join("|") : null);
// Cap implausibly-high monthly sales at import (StoreCensus occasionally emits an annual/cumulative
// figure as monthly — e.g. "$439M/mo" for a single ccTLD store). No real Shopify store does >$20M/mo.
const SALES_CEILING = 20_000_000;
const salesNum = (v) => { const n = num(v); return n == null ? null : Math.min(n, SALES_CEILING); };
// StoreCensus assumes the US Shopify stack, so outside Shopify-Payments countries it emits gateways
// that can't be real (shopify_payments/shop_pay require Shopify Payments; klarna/affirm don't operate
// there). Strip those so we never import a geographically-impossible gateway. See clean-storecensus-payments.mjs.
const SP_COUNTRIES = new Set(["US","CA","GB","AU","NZ","IE","JP","SG","HK","AT","BE","CZ","DK","FI","FR","DE","IT","NL","PT","ES","SE","CH","RO","BG","HR","CY","EE","GR","HU","LV","LT","LU","MT","PL","SK","SI"]);
const IMPOSSIBLE_PAY = new Set(["shopify_payments", "shop_pay", "apple_pay", "google_pay", "klarna", "affirm"]);
const cleanPays = (pays, country) => {
  if (!pays) return null;
  if (SP_COUNTRIES.has((country || "").toUpperCase())) return pays;
  const kept = pays.split(/[;|]/).map((t) => t.trim()).filter((t) => t && !IMPOSSIBLE_PAY.has(t.toLowerCase()));
  return kept.length ? kept.join("|") : null;
};
// StoreCensus `state` is almost always empty; `city` sometimes holds the prefecture (e.g. 東京都).
// Use state if present, else city when it looks like a 都道府県, else leave region for a later pass.
const prefecture = (state, city) => {
  if (state && state.trim()) return state.trim();
  if (city && /(都|道|府|県)$/.test(city.trim())) return city.trim();
  return null;
};

async function main() {
  const file = process.argv[2];
  const SRC = process.argv.includes("--source") ? process.argv[process.argv.indexOf("--source") + 1] : "storecensus";
  const PUBLISHED = !process.argv.includes("--unpublished");
  if (!file) { console.error("usage: import-storecensus.mjs <file.ndjson>"); process.exit(2); }

  // read NDJSON
  const rows = [];
  await new Promise((resolve) => {
    const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    rl.on("line", (l) => { l = l.trim(); if (!l) return; try { rows.push(JSON.parse(l)); } catch {} });
    rl.on("close", resolve);
  });
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  const recs = rows.filter((r) => r.d).map((r) => {
    const created = r.created || r.first || null;
    return {
      domain: r.d, name: r.d, country: (r.country || null), platform: (r.platform || "Shopify"),
      published: PUBLISHED, source: SRC, discovered_at: today,
      estimated_monthly_sales: salesNum(r.s),
      city: r.city || null, region: prefecture(r.state, r.city), geo_checked_at: (r.city || r.state) ? now : null,
      theme: r.theme || null, plan: r.plan || null, currency: r.cur || null, category: r.vert || null,
      payments: cleanPays(r.pays, r.country), payments_source: cleanPays(r.pays, r.country) ? SRC : null, payments_checked_at: cleanPays(r.pays, r.country) ? now : null,
      store_created: created, launched_at: launchFrom(created), launched_source: launchFrom(created) ? SRC : null,
      // wide fields — all gap-filled below, never clobbering our own probes
      apps: list(r.apps), technologies: list(r.tech),
      instagram: r.ig || null, facebook: r.fb || null, twitter: r.tw || null, youtube: r.yt || null,
      linkedin: r.li || null, pinterest: r.pin || null, tiktok: r.tiktok || null,
      product_count: int(r.prod), variant_count: int(r.variants), avg_product_price: num(r.avgprice),
      company: r.company || null, merchant_name: r.company || null, language: r.lang || null,
      password_protected: typeof r.pw === "boolean" ? r.pw : (r.pw == null ? null : !!+r.pw),
      tech_spend: num(r.techspend), checkout_ext_count: int(r.ckext), reviews_count: int(r.reviews),
      employee_count: int(r.employees), estimated_visits: int(r.traffic),
      growth_7d: num(r.g7), growth_30d: num(r.g30),
      catalog_checked_at: num(r.prod) != null ? now : null,
      raw: r,
    };
  });

  const cols = ["domain","name","country","platform","published","source","discovered_at","estimated_monthly_sales",
    "city","region","geo_checked_at","theme","plan","currency","category","payments","payments_source",
    "payments_checked_at","store_created","launched_at","launched_source","raw",
    "apps","technologies","instagram","facebook","twitter","youtube","linkedin","pinterest","tiktok","product_count","variant_count","avg_product_price","company","merchant_name","language","password_protected","tech_spend","checkout_ext_count","reviews_count","employee_count","estimated_visits","growth_7d","growth_30d","catalog_checked_at"];

  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 4, idle_timeout: 20 });
  try {
    const domains = recs.map((r) => r.domain);
    let before = 0;
    for (let i = 0; i < domains.length; i += 5000) {
      before += (await sql`SELECT count(*)::int n FROM imported_stores WHERE domain = ANY(${domains.slice(i, i + 5000)})`)[0].n;
    }
    for (let i = 0; i < recs.length; i += 250) {
      const batch = recs.slice(i, i + 250).map((r) => ({ ...r, raw: sql.json(r.raw) }));
      await sql`INSERT INTO imported_stores ${sql(batch, ...cols)}
        ON CONFLICT (domain) DO UPDATE SET
          estimated_monthly_sales = COALESCE(imported_stores.estimated_monthly_sales, EXCLUDED.estimated_monthly_sales),
          platform      = COALESCE(imported_stores.platform, EXCLUDED.platform),
          country       = COALESCE(imported_stores.country, EXCLUDED.country),
          city          = COALESCE(imported_stores.city, EXCLUDED.city),
          region        = COALESCE(imported_stores.region, EXCLUDED.region),
          geo_checked_at= COALESCE(imported_stores.geo_checked_at, EXCLUDED.geo_checked_at),
          theme         = COALESCE(imported_stores.theme, EXCLUDED.theme),
          plan          = COALESCE(imported_stores.plan, EXCLUDED.plan),
          currency      = COALESCE(imported_stores.currency, EXCLUDED.currency),
          category      = COALESCE(imported_stores.category, EXCLUDED.category),
          payments      = COALESCE(imported_stores.payments, EXCLUDED.payments),
          payments_source = COALESCE(imported_stores.payments_source, EXCLUDED.payments_source),
          payments_checked_at = COALESCE(imported_stores.payments_checked_at, EXCLUDED.payments_checked_at),
          store_created = COALESCE(imported_stores.store_created, EXCLUDED.store_created),
          launched_at   = COALESCE(imported_stores.launched_at, EXCLUDED.launched_at),
          launched_source = COALESCE(imported_stores.launched_source, EXCLUDED.launched_source),
          discovered_at = COALESCE(imported_stores.discovered_at, EXCLUDED.discovered_at),
          apps = COALESCE(imported_stores.apps, EXCLUDED.apps),
          technologies = COALESCE(imported_stores.technologies, EXCLUDED.technologies),
          instagram = COALESCE(imported_stores.instagram, EXCLUDED.instagram),
          facebook = COALESCE(imported_stores.facebook, EXCLUDED.facebook),
          twitter = COALESCE(imported_stores.twitter, EXCLUDED.twitter),
          youtube = COALESCE(imported_stores.youtube, EXCLUDED.youtube),
          linkedin = COALESCE(imported_stores.linkedin, EXCLUDED.linkedin),
          pinterest = COALESCE(imported_stores.pinterest, EXCLUDED.pinterest),
          tiktok = COALESCE(imported_stores.tiktok, EXCLUDED.tiktok),
          product_count = COALESCE(imported_stores.product_count, EXCLUDED.product_count),
          variant_count = COALESCE(imported_stores.variant_count, EXCLUDED.variant_count),
          avg_product_price = COALESCE(imported_stores.avg_product_price, EXCLUDED.avg_product_price),
          company = COALESCE(imported_stores.company, EXCLUDED.company),
          merchant_name = COALESCE(imported_stores.merchant_name, EXCLUDED.merchant_name),
          language = COALESCE(imported_stores.language, EXCLUDED.language),
          password_protected = COALESCE(imported_stores.password_protected, EXCLUDED.password_protected),
          tech_spend = COALESCE(imported_stores.tech_spend, EXCLUDED.tech_spend),
          checkout_ext_count = COALESCE(imported_stores.checkout_ext_count, EXCLUDED.checkout_ext_count),
          reviews_count = COALESCE(imported_stores.reviews_count, EXCLUDED.reviews_count),
          employee_count = COALESCE(imported_stores.employee_count, EXCLUDED.employee_count),
          estimated_visits = COALESCE(imported_stores.estimated_visits, EXCLUDED.estimated_visits),
          growth_7d = COALESCE(imported_stores.growth_7d, EXCLUDED.growth_7d),
          growth_30d = COALESCE(imported_stores.growth_30d, EXCLUDED.growth_30d),
          catalog_checked_at = COALESCE(imported_stores.catalog_checked_at, EXCLUDED.catalog_checked_at)`;
    }
    console.log(`imported ${recs.length} rows (${recs.length - before} new, ${before} already present) [source=${SRC}, published=${PUBLISHED}].`);
    console.log("→ next: node --env-file=.env.local scripts/source-liveness.mjs --source " + SRC + " --country <CC>");
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
