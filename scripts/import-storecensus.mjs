/** import-storecensus — upsert rich StoreCensus NDJSON exports (from the dashboard API pull)
 *  into imported_stores. One JSON object per line:
 *    {platform,country,d,s,city,state,zip,theme,created,first,plan,cur,traffic,vert,pays}
 *  Fills gaps only (COALESCE) so it never clobbers better existing data. Published as leads
 *  (platform is known + paid source); run source-liveness.mjs afterwards to confirm liveness.
 *
 *    node --env-file=.env.local scripts/import-storecensus.mjs /path/sc_jp_shopify.ndjson
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
      published: true, source: SRC, discovered_at: today,
      estimated_monthly_sales: num(r.s),
      city: r.city || null, region: prefecture(r.state, r.city), geo_checked_at: (r.city || r.state) ? now : null,
      theme: r.theme || null, plan: r.plan || null, currency: r.cur || null, category: r.vert || null,
      payments: r.pays || null, payments_source: r.pays ? SRC : null, payments_checked_at: r.pays ? now : null,
      store_created: created, launched_at: launchFrom(created), launched_source: launchFrom(created) ? SRC : null,
      raw: r,
    };
  });

  const cols = ["domain","name","country","platform","published","source","discovered_at","estimated_monthly_sales",
    "city","region","geo_checked_at","theme","plan","currency","category","payments","payments_source",
    "payments_checked_at","store_created","launched_at","launched_source","raw"];

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
          discovered_at = COALESCE(imported_stores.discovered_at, EXCLUDED.discovered_at)`;
    }
    console.log(`imported ${recs.length} rows (${recs.length - before} new, ${before} already present) [source=${SRC}].`);
    console.log("→ next: node --env-file=.env.local scripts/source-liveness.mjs --source " + SRC + " --country <CC>");
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
