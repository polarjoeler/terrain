/**
 * promo-products — the sale PRODUCTS behind each Black Friday deal, for the product shelves on
 * tembocommerce.africa/za/black-friday. Runs after promo-scan (same cron, same lock) over stores
 * that promo-scan found with a live BF offer or BF page.
 *
 * Joel's decision 2026-11-19: show stores' own product photos. Images are stored as the store's own
 * CDN URL (never copied); every product links back to the store; status = 'removed' honours an
 * opt-out the same day.
 *
 *   WooCommerce — public Store API, /wp-json/wc/store/v1/products?on_sale=true. Own-domain request,
 *                 no Shopify budget. Gives name, regular + sale price, image, permalink.
 *   Shopify     — the store's own BF collection page (the link promo-scan found), fetched DIRECT
 *                 like a visitor, ONE page per store, top --shopify-top by store_priority. It
 *                 shares the home IP's ~1,200/day Shopify budget with promo-scan's homepages, so keep
 *                 the two under it. NOT products.json and NOT the collection .atom feed (both
 *                 refused); no header tuning. 5 refusals in a row end the Shopify pass.
 *
 *   node --env-file=.env.local scripts/promo-products.mjs --dry --limit 10
 *   node --env-file=.env.local scripts/promo-products.mjs [--shopify-top 300] [--stale-hours 18]
 */
import postgres from "postgres";
import { fetchText, closeAgents } from "./lib/proxy-fetch.mjs";
import { isLiveBfPath } from "./lib/promo-detect.mjs";
import { shopifyProducts, wooProducts } from "./lib/promo-products.mjs";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DRY = has("--dry");
const LIMIT = Number(arg("--limit", 100000));
const SHOPIFY_TOP = Number(arg("--shopify-top", 300));
const STALE_H = Number(arg("--stale-hours", 18));
const MAX = Number(arg("--max", 8));
const COUNTRY = arg("--country", "ZA").toUpperCase();
const DOMAINS = arg("--domains", "") ? arg("--domains", "").split(",").map((d) => d.trim().toLowerCase()) : null;
const STREAK_STOP = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// tembocommerce.africa/za/black-friday builds read these tables through the read-only tembo_bf_ro
// role (Joel's decision 3, 2026-11-18). Granted only when missing: GRANT rewrites the table's ACL.
export async function grantTemboReader(sql, table) {
  const [{ r }] = await sql`SELECT to_regrole('tembo_bf_ro') IS NOT NULL r`;
  if (!r) return;
  const [{ ok }] = await sql`SELECT has_table_privilege('tembo_bf_ro', ${table}, 'SELECT') ok`;
  if (!ok) await sql.unsafe(`GRANT SELECT ON ${table} TO tembo_bf_ro`);
}

export async function ensureProductTables(sql) {
  const [{ t }] = await sql`SELECT to_regclass('public.store_promo_products') t`;
  if (!t) {
    await sql`CREATE TABLE store_promo_products (
      domain text NOT NULL,
      handle text NOT NULL,
      title text NOT NULL,
      url text NOT NULL,
      image text NOT NULL,                  -- the store's own CDN URL; never copied
      price numeric NOT NULL,
      regular numeric,
      pct int,
      currency text NOT NULL DEFAULT 'ZAR',
      source text NOT NULL,                 -- woo-api | shopify-collection
      rank int,                             -- order on the store's page / by discount
      status text NOT NULL DEFAULT 'auto',  -- auto | removed (store opted out)
      first_seen_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (domain, handle))`;
    await sql`CREATE INDEX store_promo_products_seen ON store_promo_products (last_seen_at DESC)`;
  }
  // Per-store clock for this lane, on promo-scan's state table. Checked first: ALTER takes an
  // ACCESS EXCLUSIVE lock even with IF NOT EXISTS.
  const [{ c }] = await sql`SELECT count(*)::int c FROM information_schema.columns WHERE table_name = 'store_promo_scan' AND column_name = 'products_at'`;
  if (!c) await sql`ALTER TABLE store_promo_scan ADD COLUMN products_at timestamptz, ADD COLUMN products_n int`;
  await grantTemboReader(sql, "store_promo_products");
  await ensurePriceHistory(sql);
}

/**
 * One row per product per day: what it cost, and the "was" price the store showed. The deal check
 * (lib/deal-verdict.mjs) compares today's price with what the product cost before the sale.
 * source = 'scan' (this lane) or 'wayback' (deal-check-backfill.mjs, archived copies from before we watched).
 */
export async function ensurePriceHistory(sql) {
  const [{ t }] = await sql`SELECT to_regclass('public.store_promo_product_prices') t`;
  if (t) return grantTemboReader(sql, "store_promo_product_prices");
  await sql`CREATE TABLE store_promo_product_prices (
    domain text NOT NULL,
    handle text NOT NULL,
    seen_on date NOT NULL,
    price numeric NOT NULL,
    regular numeric,
    source text NOT NULL DEFAULT 'scan',
    PRIMARY KEY (domain, handle, seen_on))`;
  await grantTemboReader(sql, "store_promo_product_prices");
}

async function targets(sql) {
  const rows = await sql`
    SELECT DISTINCT ON (p.domain) p.domain, lower(s.platform) platform, p.link, sp.market_rank, ps.products_at
      FROM store_promos p
      JOIN imported_stores s ON s.domain = p.domain
      LEFT JOIN store_priority sp ON sp.domain = p.domain
      LEFT JOIN store_promo_scan ps ON ps.domain = p.domain
     WHERE p.status NOT IN ('rejected', 'removed') AND s.country = ${COUNTRY}
       AND p.last_seen_at > now() - interval '48 hours'
       AND (p.kind IN ('bf', 'link') OR (p.kind = 'sale' AND NOT p.seen_in_baseline))
       AND lower(s.platform) IN ('shopify', 'woocommerce')
       ${DOMAINS ? sql`AND p.domain = ANY(${DOMAINS})` : sql``}
     ORDER BY p.domain, (p.link IS NOT NULL) DESC, p.last_seen_at DESC`;
  const cutoff = Date.now() - STALE_H * 3600e3;
  const fresh = (r) => DOMAINS || !r.products_at || new Date(r.products_at).getTime() < cutoff;
  const woo = rows.filter((r) => r.platform === "woocommerce" && fresh(r));
  const shop = rows
    .filter((r) => r.platform === "shopify" && r.link && /\/collections\//.test(r.link) && isLiveBfPath(new URL(r.link).pathname))
    .sort((a, b) => (a.market_rank ?? 1e9) - (b.market_rank ?? 1e9))
    .slice(0, SHOPIFY_TOP)
    .filter(fresh);
  return { woo: woo.slice(0, LIMIT), shop: shop.slice(0, LIMIT) };
}

async function readWoo(r) {
  const res = await fetchText(`https://${r.domain}/wp-json/wc/store/v1/products?on_sale=true&per_page=24&orderby=popularity`, { timeoutMs: 15000, maxBytes: 3_000_000 });
  if (!res) return { note: "unreachable", products: [] };
  if (res.status !== 200) return { note: `http ${res.status}`, products: [], refused: res.status === 429 };
  try { return { products: wooProducts(JSON.parse(res.text), { max: MAX }).map((p) => ({ ...p, source: "woo-api" })) }; }
  catch { return { note: "not json", products: [] }; }
}

async function readShopify(r) {
  const res = await fetchText(r.link, { timeoutMs: 20000, maxBytes: 4_500_000 });
  if (!res) return { note: "unreachable", products: [] };
  if (res.status === 429 || res.status === 430) return { note: "rate-limited", products: [], refused: true };
  if (res.status !== 200) return { note: `http ${res.status}`, products: [] };
  const origin = new URL(res.url || r.link).origin;
  return { products: shopifyProducts(res.text, origin, { max: MAX }).map((p) => ({ ...p, source: "shopify-collection" })) };
}

async function save(sql, r, out) {
  const rows = out.products.map((p, i) => ({
    domain: r.domain, handle: p.handle.slice(0, 200), title: p.title.slice(0, 200), url: p.url, image: p.image,
    price: p.price, regular: p.regular ?? null, pct: p.pct ?? null, currency: p.currency || "ZAR", source: p.source, rank: i,
  }));
  await sql.begin(async (tx) => {
    if (rows.length) {
      await tx`INSERT INTO store_promo_products ${tx(rows)}
        ON CONFLICT (domain, handle) DO UPDATE SET title = EXCLUDED.title, url = EXCLUDED.url, image = EXCLUDED.image,
          price = EXCLUDED.price, regular = EXCLUDED.regular, pct = EXCLUDED.pct, currency = EXCLUDED.currency,
          source = EXCLUDED.source, rank = EXCLUDED.rank, last_seen_at = now()`;
    }
    await tx`UPDATE store_promo_scan SET products_at = now(), products_n = ${rows.length} WHERE domain = ${r.domain}`;
    if (rows.length) {
      await tx`INSERT INTO store_promo_product_prices ${tx(rows.map((x) => ({ domain: x.domain, handle: x.handle, seen_on: new Date().toISOString().slice(0, 10), price: x.price, regular: x.regular, source: "scan" })))}
        ON CONFLICT (domain, handle, seen_on) DO UPDATE SET price = EXCLUDED.price, regular = EXCLUDED.regular`;
    }
  });
}

async function pass(sql, list, read, { pauseMs, label, stopOnRefusals }) {
  const st = { done: 0, withProducts: 0, products: 0, discounted: 0, refused: 0, failed: 0 };
  let streak = 0;
  for (const r of list) {
    const out = await read(r);
    st.done++;
    if (out.refused) { st.refused++; if (stopOnRefusals && ++streak >= STREAK_STOP) { console.log(`!! ${label}: ${STREAK_STOP} refusals in a row — stopping`); break; } }
    else streak = 0;
    if (out.note && !out.refused) st.failed++;
    if (out.products.length) { st.withProducts++; st.products += out.products.length; st.discounted += out.products.filter((p) => p.pct).length; }
    if (DRY) {
      console.log(`${label} ${String(r.market_rank ?? "-").padStart(5)} ${r.domain.padEnd(32)} ${out.note || ""} ${out.products.length} products`);
      for (const p of out.products.slice(0, 3)) console.log(`        ${p.title.slice(0, 48).padEnd(48)} R${p.price}${p.regular ? ` was R${p.regular} (-${p.pct}%)` : ""}`);
    } else if (!out.refused) await save(sql, r, out);
    await sleep(pauseMs);
  }
  console.log(`${label}: ${st.done} stores · ${st.withProducts} with products · ${st.products} products (${st.discounted} with a was-price) · ${st.failed} no answer · ${st.refused} refused`);
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3, idle_timeout: 20, connect_timeout: 30,
    connection: { statement_timeout: 60000, lock_timeout: 10000 } });
  const t0 = Date.now();
  try {
    if (!DRY) await ensureProductTables(sql);
    const [{ c }] = await sql`SELECT count(*)::int c FROM information_schema.columns WHERE table_name = 'store_promo_scan' AND column_name = 'products_at'`;
    const { woo, shop } = c ? await targets(sql) : await targetsNoState(sql);
    console.log(`promo-products ${COUNTRY}: ${woo.length} Woo (Store API) · ${shop.length} Shopify collection pages (top ${SHOPIFY_TOP})${DRY ? " · DRY" : ""}`);
    await pass(sql, woo, readWoo, { pauseMs: 700, label: "woo ", stopOnRefusals: false });
    await pass(sql, shop, readShopify, { pauseMs: 2500, label: "shop", stopOnRefusals: true });
    console.log(`promo-products done in ${Math.round((Date.now() - t0) / 60000)}m`);
  } finally {
    closeAgents();
    await sql.end({ timeout: 5 });
  }
}

// Same selection without the per-store clock (dry runs before the first real run adds the column).
async function targetsNoState(sql) {
  const rows = await sql`
    SELECT DISTINCT ON (p.domain) p.domain, lower(s.platform) platform, p.link, sp.market_rank, NULL::timestamptz products_at
      FROM store_promos p JOIN imported_stores s ON s.domain = p.domain LEFT JOIN store_priority sp ON sp.domain = p.domain
     WHERE p.status NOT IN ('rejected', 'removed') AND s.country = ${COUNTRY} AND p.last_seen_at > now() - interval '48 hours'
       AND (p.kind IN ('bf', 'link') OR (p.kind = 'sale' AND NOT p.seen_in_baseline)) AND lower(s.platform) IN ('shopify', 'woocommerce')
       ${DOMAINS ? sql`AND p.domain = ANY(${DOMAINS})` : sql``}
     ORDER BY p.domain, (p.link IS NOT NULL) DESC, p.last_seen_at DESC`;
  const woo = rows.filter((r) => r.platform === "woocommerce");
  const shop = rows.filter((r) => r.platform === "shopify" && r.link && /\/collections\//.test(r.link) && isLiveBfPath(new URL(r.link).pathname))
    .sort((a, b) => (a.market_rank ?? 1e9) - (b.market_rank ?? 1e9)).slice(0, SHOPIFY_TOP);
  return { woo: woo.slice(0, LIMIT), shop: shop.slice(0, LIMIT) };
}

main().catch((e) => { console.error(e); process.exit(1); });
