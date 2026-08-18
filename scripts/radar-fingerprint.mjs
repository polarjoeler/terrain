#!/usr/bin/env node
/**
 * Radar catalogue fingerprinting — fills store_fingerprints for the SA universe
 * so Brand Audits and the monitoring sweep have something to match against.
 *
 *   node --env-file=.env.local scripts/radar-fingerprint.mjs            # next 300 by value
 *   node --env-file=.env.local scripts/radar-fingerprint.mjs --limit 50
 *   node --env-file=.env.local scripts/radar-fingerprint.mjs --all      # everything missing/stale
 *
 * Runs from the Mac on purpose: like AI enrichment, it fetches each merchant's
 * /products.json, which is throttled/unreliable from serverless. Resumable —
 * skips stores already fingerprinted within STALE_DAYS. Value-ranked so the
 * highest-revenue stores are covered first.
 *
 * Fingerprint logic MIRRORS lib/radar/catalog.ts (imageStem / fetchCatalog /
 * buildFingerprint); keep in sync if that file changes.
 */

import postgres from "postgres";

const ALL = process.argv.includes("--all");
const limArg = process.argv.indexOf("--limit");
const LIMIT = ALL ? null : limArg > -1 ? Number(process.argv[limArg + 1]) : 300;
const CONCURRENCY = 6;
const MAX_PAGES = 4; // 1000 products — matches lib/radar/fingerprints.ts enrichStore
const STALE_DAYS = 30;
const MARKET = "South Africa";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const clean = (d) =>
  (d || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");

// Shopify appends a size token before the extension — strip it so the same
// source image matches across stores.
const SIZE_SUFFIX =
  /_(?:pico|icon|thumb|small|compact|medium|large|grande|original|master|\d+x\d*|x\d+)$/i;

function imageStem(src) {
  try {
    const path = new URL(src, "https://x").pathname;
    let base = path.split("/").pop() || "";
    base = base.replace(/\.[a-z0-9]+$/i, "").replace(SIZE_SUFFIX, "");
    return base.toLowerCase().trim();
  } catch {
    return "";
  }
}

const normTitle = (t) => (t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function getJson(url, ms = 8000) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(ms) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** Build a fingerprint from a store's paginated /products.json. */
async function fingerprint(domain) {
  const d = clean(domain);
  const base = `https://${d}`;
  const imageStems = new Set(), skus = new Set(), handles = new Set(), titles = new Set();
  const priceByHandle = {};
  let nProducts = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await getJson(`${base}/products.json?limit=250&page=${page}`);
    const items = data?.products;
    if (!Array.isArray(items) || items.length === 0) break;
    for (const p of items) {
      nProducts++;
      const handle = (p.handle || "").toLowerCase();
      if (handle) handles.add(handle);
      if (p.title) titles.add(normTitle(p.title));
      for (const img of p.images || []) {
        if (img?.src) { const s = imageStem(img.src); if (s) imageStems.add(s); }
      }
      const prices = [];
      for (const v of p.variants || []) {
        if (v?.sku) skus.add(String(v.sku).trim());
        if (v?.price != null) { const n = parseFloat(v.price); if (!Number.isNaN(n)) prices.push(n); }
      }
      if (handle && prices.length) priceByHandle[handle] = Math.min(...prices);
    }
    if (items.length < 250) break;
  }
  return {
    nProducts,
    imageStems: [...imageStems],
    skus: [...skus],
    handles: [...handles],
    titles: [...titles],
    priceByHandle,
  };
}

async function processStore(sql, row) {
  const fp = await fingerprint(row.domain);
  const status = fp.nProducts === 0 ? "empty" : "ok";
  await sql`
    INSERT INTO store_fingerprints (
      domain, name, market, n_products, image_stems, skus, handles, titles,
      price_by_handle, status, enriched_at
    ) VALUES (
      ${row.domain}, ${row.name}, ${MARKET}, ${fp.nProducts},
      ${sql.json(fp.imageStems)}, ${sql.json(fp.skus)}, ${sql.json(fp.handles)},
      ${sql.json(fp.titles)}, ${sql.json(fp.priceByHandle)}, ${status}, now()
    )
    ON CONFLICT (domain) DO UPDATE SET
      name = EXCLUDED.name, market = EXCLUDED.market, n_products = EXCLUDED.n_products,
      image_stems = EXCLUDED.image_stems, skus = EXCLUDED.skus, handles = EXCLUDED.handles,
      titles = EXCLUDED.titles, price_by_handle = EXCLUDED.price_by_handle,
      status = EXCLUDED.status, enriched_at = now()`;
  return status;
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: CONCURRENCY + 1 });
  try {
    await sql`SELECT 1`;
    const cutoff = new Date(Date.now() - STALE_DAYS * 864e5);
    const rows = await sql`
      SELECT i.domain, i.name
      FROM imported_stores i
      LEFT JOIN store_fingerprints f ON f.domain = i.domain
      WHERE i.published AND i.country = 'ZA'
        AND (i.live_status IS NULL OR i.live_status NOT IN ('dead', 'migrated'))
        AND (f.domain IS NULL OR f.enriched_at < ${cutoff})
      ORDER BY i.estimated_monthly_sales DESC NULLS LAST, i.created_at DESC
      ${LIMIT ? sql`LIMIT ${LIMIT}` : sql``}`;

    if (!rows.length) { console.log("Nothing to fingerprint — SA universe is fully covered."); return; }
    console.log(`Fingerprinting ${rows.length} store(s) at concurrency ${CONCURRENCY}…\n`);

    let done = 0, ok = 0, empty = 0;
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const batch = rows.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map((r) => processStore(sql, r).catch(() => "empty")),
      );
      for (const s of results) s === "ok" ? ok++ : empty++;
      done += batch.length;
      if (done % 60 === 0 || done === rows.length) {
        console.log(`— ${done}/${rows.length}  (${ok} with catalogue, ${empty} empty)`);
      }
    }
    console.log(`\nDone. ${done} fingerprinted · ${ok} with catalogue · ${empty} empty/unreachable.`);
  } finally { await sql.end(); }
}

main().catch((e) => { console.error("failed:", e.message); process.exit(1); });
