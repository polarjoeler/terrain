/**
 * sitemap-fp — fingerprint Shopify catalogues from their public product sitemaps.
 *
 * catalog-enrich reads /products.json, which Shopify refuses on most requests from us (~90% on the
 * --fp pass; 5,964 visible stores parked as refused on 2026-11-18). Every Shopify store also publishes
 * /sitemap.xml → /sitemap_products_N.xml for search engines: each product's URL (→ handle), image and
 * image title. Tested 2026-11-18 on 30 random live African stores through the Webshare fleet, one at a
 * time: 19 answered, 0 × 429, and 12 of the 15 products.json-refused stores answered. No header or
 * client tuning — it's the page crawlers are meant to read.
 *
 * What it gives Radar: handles + images + titles, in the SAME normalisation as catalog-enrich
 * (lib/catalog-fp.mjs), so sitemap fingerprints compare directly with products.json and Woo ones.
 * Handles meet Radar's evidence floor. No SKUs or prices (the price arrays are 0 = unknown, which
 * priceMirror ignores).
 *
 * Only stores with no fingerprint, or parked by the products.json lane (n_products = -1), are read;
 * a real products.json fingerprint is never overwritten. A failed sitemap is parked as n_products = -2
 * (30 days for a definite no: 402 frozen / 403 / 404 / no product sitemap; 1 day for a network
 * miss, after one retry on another proxy). A 429 is never parked, and 5 in a row end the run.
 *
 *   node --env-file=.env.local scripts/sitemap-fp.mjs --dry --limit 20
 *   node --env-file=.env.local scripts/sitemap-fp.mjs [--limit 2000] [--concurrency 2] [--pause-ms 1000] [--max-files 4]
 */
import postgres from "postgres";
import { loadProxies, pickProxy, fetchText, closeAgents } from "./lib/proxy-fetch.mjs";
import { buildFp, upsertFp, ensureFpTable } from "./lib/catalog-fp.mjs";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DRY = has("--dry");
const LIMIT = Number(arg("--limit", 2000));
const CONC = Number(arg("--concurrency", 2));
const PAUSE_MS = Number(arg("--pause-ms", 1000));
const MAX_FILES = Number(arg("--max-files", 4));          // ~1,000 products per file → ~4,000, the lane's usual cap
const MARKETS = (arg("--countries", "") || "AO,BW,CI,CM,DZ,EG,ET,GH,KE,LS,LY,MA,MU,MW,MZ,NA,NG,RW,SN,SO,SZ,TN,TZ,UG,ZA,ZM,ZW").split(",").map((c) => c.trim().toUpperCase());
const STREAK_STOP = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decode = (s) => s.replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");

// One <url> block per product: <loc>…/products/<handle></loc> + optional <image:image>.
export function parseProductSitemap(xml) {
  const out = [];
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const block = m[1];
    const loc = block.match(/<loc>([^<]+)<\/loc>/)?.[1];
    const handle = loc && decode(loc).match(/\/products\/([^/?#]+)/)?.[1];
    if (!handle) continue;                                  // the first entry is the shop root
    const img = block.match(/<image:loc>([^<]+)<\/image:loc>/)?.[1];
    const title = block.match(/<image:title>([^<]*)<\/image:title>/)?.[1];
    out.push({ handle: decodeURIComponent(handle), title: title ? decode(title) : "", images: img ? [{ src: decode(img) }] : [], variants: [] });
  }
  return out;
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3, idle_timeout: 20, connect_timeout: 30,
    connection: { statement_timeout: 60000, lock_timeout: 10000 } });
  const pool = loadProxies();
  try {
    await ensureFpTable(sql);
    const rows = await sql`
      SELECT s.domain FROM imported_stores s LEFT JOIN store_catalog_fp f ON f.domain = s.domain
        LEFT JOIN store_priority p ON p.domain = s.domain
       WHERE s.published AND lower(s.platform) = 'shopify' AND upper(s.country) = ANY(${MARKETS})
         AND coalesce(s.live_status, '') NOT IN ('dead', 'migrated') AND s.activity_tier IS DISTINCT FROM 'not_a_store'
         AND (f.domain IS NULL OR f.n_products = -1 OR (f.n_products = -2 AND f.fp_at < now()))
       -- Biggest first (store_priority): brands are the clone victims Radar exists for. Bare
       -- *.myshopify.com hosts last — on 11-18 most of them were closed (404) or frozen (402).
       ORDER BY (s.payments ILIKE '%peach%') DESC, (s.domain LIKE '%.myshopify.com') ASC, p.score DESC NULLS LAST, s.domain
       LIMIT ${LIMIT}`;
    console.log(`sitemap-fp: ${rows.length.toLocaleString()} stores · concurrency ${CONC} · ${PAUSE_MS}ms pause · ${pool.length ? `${pool.length} proxies` : "DIRECT"}${DRY ? " · DRY" : ""}`);

    const park = (domain, days) => DRY ? null : sql`
      INSERT INTO store_catalog_fp (domain, n_products, img, sku, handle, title, price, fp_at)
      VALUES (${domain}, -2, '{}', '{}', '{}', '{}', '{}', now() + make_interval(days => ${days}))
      ON CONFLICT (domain) DO UPDATE SET n_products = CASE WHEN store_catalog_fp.n_products > 0 THEN store_catalog_fp.n_products ELSE -2 END,
        fp_at = CASE WHEN store_catalog_fp.n_products > 0 THEN store_catalog_fp.fp_at ELSE now() + make_interval(days => ${days}) END`;

    const st = { ok: 0, empty: 0, products: 0, refused429: 0, definite: 0, net: 0, requests: 0, bytes: 0 };
    let i = 0, streak = 0, stop = false;
    const get = async (url) => {
      st.requests++;
      const r = await fetchText(url, { proxy: pickProxy(pool), timeoutMs: 20000, maxBytes: 12_000_000 });
      if (r?.status === 429) { st.refused429++; if (++streak >= STREAK_STOP) stop = true; } else if (r) streak = 0;
      if (r?.text) st.bytes += r.text.length;
      return r;
    };
    const worker = async () => {
      while (i < rows.length && !stop) {
        const { domain } = rows[i++];
        try {
          // A network miss is usually one bad proxy (7–16% of fleet requests): retry once on another.
          let idx = await get(`https://${domain}/sitemap.xml`);
          if (!idx) { await sleep(PAUSE_MS); idx = await get(`https://${domain}/sitemap.xml`); }
          if (!idx) { st.net++; await park(domain, 1); continue; }
          if (idx.status === 429) continue;                        // never park a throttle
          if (idx.status !== 200) { st.definite++; await park(domain, 30); continue; }
          const files = [...idx.text.matchAll(/<loc>([^<]*sitemap_products[^<]*)<\/loc>/g)].map((m) => decode(m[1])).slice(0, MAX_FILES);
          if (!files.length) { st.definite++; await park(domain, 30); continue; }
          const products = [];
          let throttled = false, failed = false;
          for (const f of files) {
            await sleep(PAUSE_MS);
            const r = await get(f);
            if (r?.status === 429) { throttled = true; break; }
            if (!r || r.status !== 200) { failed = true; break; }
            products.push(...parseProductSitemap(r.text));
          }
          if (throttled) continue;
          if (failed && !products.length) { st.net++; await park(domain, 1); continue; }
          if (!products.length) st.empty++; else st.ok++;
          st.products += products.length;
          if (!DRY) await upsertFp(sql, domain, buildFp(products), null);
          else if (st.ok <= 8 && products.length) console.log(`  ✓ ${domain}: ${products.length} products (e.g. ${products[0].handle} · "${products[0].title.slice(0, 40)}")`);
        } finally {
          await sleep(PAUSE_MS);
          const done = st.ok + st.empty + st.definite + st.net;
          if (done % 100 === 0 && done) console.log(`  ${done}/${rows.length}  fingerprinted ${st.ok} · empty ${st.empty} · no sitemap/402/403 ${st.definite} · unreachable ${st.net} · 429 ${st.refused429}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONC, rows.length) }, worker));
    if (stop) console.log(`! stopped: ${STREAK_STOP} refusals (429) in a row — Shopify is limiting; the rest wait for the next run.`);
    console.log(`\n✓ Done${DRY ? " (dry, nothing written)" : ""}. ${st.ok} fingerprinted (${st.products.toLocaleString()} products) · ${st.empty} empty · ${st.definite} no sitemap/402/403 (30d) · ${st.net} unreachable (1d) · ${st.refused429} × 429 · ${st.requests} requests · ${(st.bytes / 1048576).toFixed(1)} MB`);
  } finally {
    closeAgents();
    await sql.end({ timeout: 5 });
  }
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error("sitemap-fp failed:", e.message); process.exit(1); });
