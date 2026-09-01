#!/usr/bin/env node
/**
 * One-time bulk import of a StoreLeads-style CSV into imported_stores.
 *
 *   node --env-file=.env.local scripts/import-storeleads.mjs "/path/to/ShopifyZA.csv"
 *
 * Preserves the full source row in `raw` (jsonb) and promotes the high-value
 * fields to typed columns for ranking/display. Idempotent: ON CONFLICT (domain)
 * updates. Sanity-caps absurd sales estimates. Tags source so it's reversible.
 */

import { readFileSync } from "node:fs";
import postgres from "postgres";

const SOURCE = "storeleads-2026-08";
const BATCH = 150; // small batches keep each INSERT under Supabase's statement timeout
const SALES_CAP = 1_000_000_000; // > $1B/mo is a data error, not a store

const DRY = process.argv.includes("--dry");
const file = process.argv.find((a, i) => i >= 2 && !a.startsWith("--"));
if (!file) {
  console.error("usage: node scripts/import-storeleads.mjs <csv-path>");
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set (run with --env-file=.env.local)");
  process.exit(2);
}

/* ---- RFC-4180 CSV parser (quotes, embedded commas/newlines) --------------- */
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  const t = text.replace(/\r\n?/g, "\n");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const cleanDomain = (s) =>
  (s || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
const money = (s) => {
  if (!s) return null;
  const n = parseFloat(String(s).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const int = (s) => {
  if (!s) return null;
  const n = parseInt(String(s).replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
};
const first = (s, sep = ":") => (s ? String(s).split(sep)[0].trim() || null : null);
// Fix the common Windows-1252-as-UTF8 mojibake in display names (raw keeps original).
const demoji = (s) =>
  !s ? s : s
    .replace(/Â(?=[®™©°])/g, "")
    .replace(/â€™/g, "'").replace(/â€œ|â€/g, '"').replace(/â€"/g, "—");
const isoDate = (s) => (s ? String(s).trim().replace(/\//g, "-").slice(0, 10) || null : null);
// StoreLeads' store-creation date as a MONTH-precision launch proxy (first of month).
// Month/year is precise enough for older stores; own-sourced earliest_product (when we
// have it) is day-precise and wins via COALESCE in the upsert below.
const monthOf = (s) => { const d = isoDate(s); return d ? d.slice(0, 7) + "-01" : null; };

function mapRow(r) {
  const domain = cleanDomain(r.domain);
  if (!domain) return null;
  let sales = money(r.estimated_monthly_sales);
  if (sales != null && sales > SALES_CAP) sales = null; // drop obvious outliers
  const plan = (r.last_plan || r.plan || "").trim() || null;
  return {
    domain,
    name: demoji((r.merchant_name || r.title || domain).trim()),
    merchant_name: demoji((r.merchant_name || "").trim()) || null,
    country: (r.country_code || "ZA").trim().toUpperCase(),
    currency: (r.currency || "").trim() || null,
    email: first(r.emails),
    phone: first(r.phones),
    plus: /plus/i.test(plan || ""),
    plan,
    theme: (r.theme || "").trim() || null,
    category: (r.categories || "").split("/").filter(Boolean)[0] || null,
    city: (r.city || "").trim() || null,
    region: (r.state || "").trim() || null,
    rank: int(r.rank),
    estimated_monthly_sales: sales,
    products_sold: int(r.products_sold),
    avg_product_price: money(r.average_product_price),
    instagram_followers: int(r.instagram_followers),
    facebook_followers: int(r.facebook_followers),
    employee_count: int(r.employee_count),
    apps: (r.installed_apps || "").trim() || null,
    store_created: isoDate(r.created),
    first_seen: isoDate(r.created),
    launched_at: monthOf(r.created),
    launched_source: r.created ? "storeleads_created" : null,
    status: (r.status || "").trim() || null,
    source: SOURCE,
    published: true,
    raw: r,
  };
}

const COLS = [
  "domain", "name", "merchant_name", "country", "currency", "email", "phone",
  "plus", "plan", "theme", "category", "city", "region", "rank",
  "estimated_monthly_sales", "products_sold", "avg_product_price",
  "instagram_followers", "facebook_followers", "employee_count", "apps",
  "store_created", "first_seen", "launched_at", "launched_source", "status", "source", "published", "raw",
];

async function main() {
  console.log(`Reading ${file} …`);
  const parsed = parseCsv(readFileSync(file, "utf8"));
  const header = parsed[0];
  const records = [];
  const seen = new Set();
  for (let i = 1; i < parsed.length; i++) {
    const cells = parsed[i];
    if (!cells || cells.length < 2) continue;
    const obj = {};
    header.forEach((h, j) => (obj[h] = cells[j] ?? ""));
    const row = mapRow(obj);
    if (!row || seen.has(row.domain)) continue; // last-write dedupe within file
    seen.add(row.domain);
    records.push(row);
  }
  console.log(`Parsed ${records.length.toLocaleString()} unique stores.`);

  if (DRY) {
    const withSales = records.filter((r) => r.estimated_monthly_sales != null).length;
    const withEmail = records.filter((r) => r.email).length;
    const plus = records.filter((r) => r.plus).length;
    console.log(`  with sales: ${withSales.toLocaleString()} · with email: ${withEmail.toLocaleString()} · Plus: ${plus}`);
    console.log("  sample mapped rows:");
    for (const r of [...records].sort((a, b) => (b.estimated_monthly_sales || 0) - (a.estimated_monthly_sales || 0)).slice(0, 5)) {
      console.log(`   ${r.domain} · ${r.name} · ${r.category} · $${(r.estimated_monthly_sales || 0).toLocaleString()}/mo · ${r.email || "no email"}`);
    }
    console.log("DRY run — no writes.");
    return;
  }

  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 4 });
  try {
    // Ensure the imported_stores rich columns exist (idempotent) before loading.
    const ddl = readFileSync(new URL("../lib/schema.sql", import.meta.url), "utf8");
    await sql.unsafe(ddl);

    // Resume: skip domains already imported under this source.
    const existing = new Set(
      (await sql`SELECT domain FROM imported_stores WHERE source = ${SOURCE}`).map((r) => r.domain),
    );
    const pending = records.filter((r) => !existing.has(r.domain));
    console.log(`  ${existing.size.toLocaleString()} already imported, ${pending.length.toLocaleString()} remaining.`);
    records.length = 0;
    records.push(...pending);

    let done = 0;
    for (let i = 0; i < records.length; i += BATCH) {
      const batch = records.slice(i, i + BATCH);
      await sql`
        INSERT INTO imported_stores ${sql(batch, ...COLS)}
        ON CONFLICT (domain) DO UPDATE SET
          name = EXCLUDED.name,
          merchant_name = EXCLUDED.merchant_name,
          country = EXCLUDED.country,
          currency = COALESCE(EXCLUDED.currency, imported_stores.currency),
          email = COALESCE(EXCLUDED.email, imported_stores.email),
          phone = COALESCE(EXCLUDED.phone, imported_stores.phone),
          plus = EXCLUDED.plus,
          plan = EXCLUDED.plan,
          theme = COALESCE(EXCLUDED.theme, imported_stores.theme),
          category = EXCLUDED.category,
          city = EXCLUDED.city,
          region = EXCLUDED.region,
          rank = EXCLUDED.rank,
          estimated_monthly_sales = EXCLUDED.estimated_monthly_sales,
          products_sold = EXCLUDED.products_sold,
          avg_product_price = EXCLUDED.avg_product_price,
          instagram_followers = EXCLUDED.instagram_followers,
          facebook_followers = EXCLUDED.facebook_followers,
          employee_count = EXCLUDED.employee_count,
          apps = EXCLUDED.apps,
          store_created = EXCLUDED.store_created,
          -- Never clobber an existing launch date: own-sourced earliest_product is
          -- day-precise and takes precedence over the StoreLeads month proxy.
          launched_at = COALESCE(imported_stores.launched_at, EXCLUDED.launched_at),
          launched_source = COALESCE(imported_stores.launched_source, EXCLUDED.launched_source),
          status = EXCLUDED.status,
          source = EXCLUDED.source,
          published = true,
          raw = EXCLUDED.raw
      `;
      done += batch.length;
      process.stdout.write(`\r  ${done.toLocaleString()} / ${records.length.toLocaleString()}`);
    }
    process.stdout.write("\n");

    const [{ count }] = await sql`SELECT COUNT(*)::int count FROM imported_stores WHERE source = ${SOURCE}`;
    const [top] = await sql`
      SELECT domain, estimated_monthly_sales FROM imported_stores
      WHERE source = ${SOURCE} AND estimated_monthly_sales IS NOT NULL
      ORDER BY estimated_monthly_sales DESC LIMIT 1`;
    console.log(`✓ Imported. ${count.toLocaleString()} rows tagged ${SOURCE}.`);
    if (top) console.log(`  Highest-value store: ${top.domain} ($${Number(top.estimated_monthly_sales).toLocaleString()}/mo est.)`);
  } finally {
    await sql.end();
  }
}

main().catch((e) => { console.error("\nimport failed:", e.message); process.exit(1); });
