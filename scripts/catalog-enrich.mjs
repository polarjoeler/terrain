/** Catalog enrichment — capture clean product data from each store's public
 *  /products.json (footprint-free: no cart, no checkout, just a public read).
 *  Fills product_count + avg_product_price (AOV) so the revenue estimator and
 *  Lead Fit Score have real signals instead of the noisy imported figures.
 *
 *  Value-ranked, resumable (skips stores already enriched), bounded worker pool.
 *   node --env-file=.env.local scripts/catalog-enrich.mjs [--limit 3000] [--all] [--country ZA,KE]
 *   node … scripts/catalog-enrich.mjs --recheck --all   # re-enrich rows the old (buggy) pass got wrong
 *   node … scripts/catalog-enrich.mjs --fp --limit 500  # (re)fingerprint ZA/KE/NG catalogues
 *
 *  Fingerprints (store_catalog_fp, see lib/catalog-fp.mjs) ride on the same products.json download:
 *  a ZA/KE/NG store gets one on its first catalog pass at no extra fetch. --fp is the backfill for
 *  stores checked before fingerprints existed, and the monthly refresh (FP_STALE_DAYS) after that.
 */
import postgres from "postgres";
import { loadProxies, pickProxy, fetchText, closeAgents } from "./lib/proxy-fetch.mjs";
import { buildFp, ensureFpTable, upsertFp, deferFp, EMPTY_FP, FP_MARKETS, FP_STALE_DAYS } from "./lib/catalog-fp.mjs";

const ALL = process.argv.includes("--all");
// --recheck re-runs stores the first pass measured with the two known bugs: product_count pinned at
// the 250 page-limit (no pagination), or an outlier-inflated avg_product_price. Everything else is
// left alone, so the re-run only touches the ~6k broken rows, not the whole fleet.
const RECHECK = process.argv.includes("--recheck");
const FP = process.argv.includes("--fp");
const li = process.argv.indexOf("--limit");
const LIMIT = ALL ? 0 : li > -1 ? Number(process.argv[li + 1]) : 3000;
// --country ZA,KE,NG,… scopes the backfill to the markets we sell into (the launch metric is
// per-country), so we don't spend the run enriching the globally-banked ccTLD stores first.
const ci = process.argv.indexOf("--country");
const COUNTRIES = ci > -1 ? process.argv[ci + 1].split(",").map((c) => c.trim().toUpperCase()).filter(Boolean) : null;
// Low concurrency + a per-request pause: hitting products.json too fast gets our IP
// HTTP 429'd (Shopify/Cloudflare throttle), which was tanking the hit rate. --recheck is
// pagination-heavy (it targets large catalogues by design), so it paces gentler by default.
// Override with --concurrency N / --pause MS.
const flagNum = (name, dflt) => { const i = process.argv.indexOf(name); return i > -1 ? Number(process.argv[i + 1]) : dflt; };
const POOL = 6;
// Webshare fan-out: when STORE_PROBE_PROXY_FILE points at the fleet, every products.json fetch goes
// out on a RANDOM proxy (one of ~100 IPs), so we're no longer pinned to this machine's single
// Shopify-edge rate budget (see memory: residential-ip-rate-budget / shopify-crawl-rate-ceiling).
// That is the whole point of this lane — it lets us raise concurrency and drop the pause. With NO
// proxy file the pool is empty and behaviour is identical to the old single-IP direct path.
//   STORE_PROBE_PROXY_FILE=~/shopify-radar/proxies.txt node … scripts/catalog-enrich.mjs --country ZA
const PROXIES = loadProxies();
const PROXIED = PROXIES.length > 0;
// --recheck re-probes large-catalogue stores (it selects on product_count>=250), so it paginates
// heavily; direct, concurrent workers never let the shared IP's Shopify-edge throttle recover and
// nearly everything 429s — so DIRECT recheck runs sequentially. Fanned across the fleet, each request
// is a different IP, so concurrency is safe and the pause is just politeness per store.
// --fp takes what Shopify will give at a polite pace: a 429 here is the store saying "not now", so
// the fingerprint lane never retries it in-run (no hopping to another proxy) — it comes back in a few
// days instead (FP_RETRY_DAYS). Lower default concurrency for the same reason.
const CONCURRENCY = flagNum("--concurrency", FP ? (PROXIED ? 6 : 2) : RECHECK ? (PROXIED ? 8 : 1) : (PROXIED ? 24 : 4));
const FP_RETRY_DAYS = 3;
const PAUSE_MS = flagNum("--pause", PROXIED ? 50 : (RECHECK ? 600 : 250));
// Pagination cap: up to 3,000 products/store. Only stores with a full first page ever fetch a
// second, so this adds requests for large catalogues only — keeps the shared IP's Shopify-edge
// rate budget intact (see memory: residential-ip-rate-budget).
const MAX_PAGES = 12;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const round2 = (n) => Math.round(n * 100) / 100;
function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
// AOV = median across products of each product's median variant price. Two robustness wins over the
// old plain mean of every variant: a many-variant product (30 size/colour SKUs) counts ONCE not 30×,
// and a single wholesale/pallet/bundle SKU can't drag the figure up (median ignores the tail). Gift
// cards are excluded — they're not a real basket item. Currency-agnostic (no per-market price cap).
function catalogAov(products) {
  const perProduct = [];
  for (const p of products) {
    const t = `${p.product_type || ""} ${p.title || ""}`.toLowerCase();
    if (t.includes("gift card") || t.includes("gift voucher") || t.includes("egift")) continue;
    const vp = (p.variants ?? []).map((v) => parseFloat(v.price)).filter((n) => n > 0);
    if (vp.length) perProduct.push(median(vp));
  }
  const m = median(perProduct);
  return m != null ? round2(m) : null;
}

// note = null on success; retriable=true means don't mark it done (try again next run:
// rate-limits and transient errors clear), false means terminal (not Shopify / gone).
// Fetch one page as {status, json}; json is parsed (null if unparseable / non-JSON), status 0 = a
// network / proxy-level failure. Backs off IN PLACE on 429/5xx (or a dead proxy) so a transient
// throttle doesn't discard the whole (often multi-page) store. maxBytes is generous because a rich
// 250-product page can be a few MB — the helper's default 700KB cap would truncate it into bad JSON.
async function fetchPage(domain, page) {
  const url = `https://${domain}/products.json?limit=250&page=${page}`;
  for (let attempt = 0; ; attempt++) {
    if (PROXIED) {
      const r = await fetchText(url, { proxy: pickProxy(PROXIES), timeoutMs: 15000, maxBytes: 8_000_000, ua: UA, redirects: 3 });
      const status = r ? r.status : 0;   // null => DNS/TLS/timeout/dead proxy
      if ((status === 0 || status === 429 || status >= 500) && attempt < (FP ? 0 : 3)) { await sleep(1200 * (attempt + 1)); continue; }
      let json = null; if (r) { try { json = JSON.parse(r.text); } catch { /* non-JSON */ } }
      return { status, json };
    }
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(15000), redirect: "follow",
    });
    if ((res.status === 429 || res.status >= 500) && attempt < (FP ? 0 : 3)) { await sleep(1500 * (attempt + 1)); continue; }
    const json = res.ok ? await res.json().catch(() => null) : null;
    return { status: res.status, json };
  }
}

async function fetchCatalog(domain) {
  const all = [];
  const seen = new Set();       // dedupe by product id — robust even if a store ignores ?page
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { status, json } = await fetchPage(domain, page);
      // still throttled/unreachable after retries — redo the whole store next run rather than bank a short count
      if (status === 0 || status === 429 || status >= 500) return { note: `http_${status}`, retriable: true };
      if (status < 200 || status >= 300) { if (page === 1) return { note: `http_${status}`, retriable: false }; break; }
      if (!json || !Array.isArray(json.products)) { if (page === 1) return { note: "not_shopify_json", retriable: false }; break; }
      let added = 0;
      for (const p of json.products) if (!seen.has(p.id)) { seen.add(p.id); all.push(p); added++; }
      // Stop unless this was a full page of NEW products. added===0 means ?page was ignored
      // (same 250 returned) → we already have them all; a short page means the real last page.
      if (json.products.length < 250 || added === 0) break;
      await sleep(PAUSE_MS);
    }
    // Own-sourced launch date: the earliest product's publish date ≈ when the store went live.
    const dates = all.map((p) => p.published_at || p.created_at).filter(Boolean).sort();
    const launched = dates.length ? String(dates[0]).slice(0, 10) : null;
    return { count: all.length, avg: catalogAov(all), launched, products: all, note: null };
  } catch (e) {
    return { note: e.name === "TimeoutError" ? "timeout" : "error", retriable: e.name === "TimeoutError" };
  }
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: POOL, idle_timeout: 20 });
  try {
    // Guarded ALTER: a bare ADD COLUMN IF NOT EXISTS still grabs ACCESS EXCLUSIVE on every run, and
    // under lane contention that can jam the hot table (memory: postgres-schema-check-lock). Only lock
    // if the column is genuinely absent.
    const [col] = await sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'imported_stores' AND column_name = 'catalog_checked_at'`;
    if (!col) await sql`ALTER TABLE imported_stores ADD COLUMN catalog_checked_at TIMESTAMPTZ`;
    await ensureFpTable(sql);
    const rows = FP ? await sql`
      -- Fingerprint backfill / refresh: focus-market stores known to have a catalogue whose
      -- fingerprint is missing or stale — missing first, then the biggest stores (brands worth
      -- protecting, and the likeliest to be cloned).
      SELECT s.domain, s.country FROM imported_stores s
      LEFT JOIN store_catalog_fp f ON f.domain = s.domain
      WHERE s.published AND (s.live_status IS NULL OR s.live_status NOT IN ('dead','migrated'))
        AND upper(s.country) = ANY(${COUNTRIES ?? FP_MARKETS}) AND s.product_count > 0
        AND lower(s.platform) IS DISTINCT FROM 'woocommerce'
        AND (f.domain IS NULL OR f.fp_at < now() - make_interval(days => ${FP_STALE_DAYS}))
      ORDER BY (f.domain IS NULL) DESC, s.estimated_monthly_sales DESC NULLS LAST, s.domain
      ${LIMIT > 0 ? sql`LIMIT ${LIMIT}` : sql``}` : await sql`
      SELECT domain, country FROM imported_stores
      WHERE published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
        ${RECHECK
          // the two bug signatures: count truncated at the 250 page-limit, or an inflated AOV
          ? sql`AND catalog_checked_at IS NOT NULL AND (product_count >= 250 OR avg_product_price > 2000)`
          : sql`AND catalog_checked_at IS NULL`}
        AND lower(platform) IS DISTINCT FROM 'woocommerce'   -- Woo has its own probe; products.json is Shopify-only
        ${COUNTRIES ? sql`AND country = ANY(${COUNTRIES})` : sql``}
      -- Priority for the LAUNCH metric: catalog-enrich fills launched_at (= earliest product date)
      -- only where it's missing, so stores with NO launch date come first — they're what actually
      -- moves the "new stores launched" count. Confirmed Shopify before unconfirmed (platform NULL),
      -- because the NULL bucket is mostly banked ccTLD certs that aren't stores (they time out and
      -- tank throughput). Recent discoveries first within each group.
      -- ZA-first: the focus markets we sell into lead (the launch metric is per-country and this is
      -- where coverage matters), then stores missing a launch date, then confirmed Shopify before the
      -- unconfirmed NULL bucket (banked ccTLD certs that time out and tank throughput).
      ORDER BY (upper(country) = ANY(ARRAY['ZA','KE','NG'])) DESC, (launched_at IS NULL) DESC, (platform = 'Shopify') DESC,
               discovered_at DESC NULLS LAST, estimated_monthly_sales DESC NULLS LAST, created_at DESC
      ${LIMIT > 0 ? sql`LIMIT ${LIMIT}` : sql``}`;
    console.log(`${FP ? "Fingerprinting" : "Catalog-enriching"} ${rows.length.toLocaleString()} stores (concurrency ${CONCURRENCY}${PROXIED ? `, fanned across ${PROXIES.length} proxies` : ", DIRECT single-IP"})…`);

    let i = 0, ok = 0, done = 0, fps = 0, throttled = 0;
    async function worker() {
      while (i < rows.length) {
        const { domain, country } = rows[i++];
        const r = await fetchCatalog(domain);
        const wantFp = FP || FP_MARKETS.includes(String(country ?? "").toUpperCase());
        if (r.note == null) {
          await sql`UPDATE imported_stores SET product_count = ${r.count},
                    avg_product_price = COALESCE(${r.avg}, avg_product_price),
                    launched_at = COALESCE(${r.launched}, launched_at),
                    launched_source = CASE WHEN ${r.launched}::text IS NOT NULL AND launched_at IS NULL THEN 'earliest_product' ELSE launched_source END,
                    -- A valid products.json IS proof of Shopify — confirm any store still unlabeled.
                    platform = COALESCE(platform, 'Shopify'),
                    catalog_checked_at = now()
                    WHERE domain = ${domain}`;
          if (wantFp) { await upsertFp(sql, domain, buildFp(r.products), r.launched); fps++; }
          ok++;
        } else if (!r.retriable) {
          // Terminal (not Shopify / gone) — mark done so we don't keep trying it.
          await sql`UPDATE imported_stores SET catalog_checked_at = now() WHERE domain = ${domain}`;
          if (wantFp) await upsertFp(sql, domain, EMPTY_FP, null);
        } else if (FP) {
          // Throttled / transient: park it for FP_RETRY_DAYS (an existing fingerprint is kept), so
          // the same refusing stores don't head every run's batch.
          await deferFp(sql, domain, FP_STALE_DAYS - FP_RETRY_DAYS); throttled++;
        } // retriable (429/5xx/timeout): leave catalog_checked_at NULL → picked up next run
        if (++done % 200 === 0) process.stdout.write(`\r  ${done}/${rows.length}  (${ok} with catalog)`);
        await sleep(PAUSE_MS);
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    console.log(`\n✓ Done. ${ok}/${rows.length} returned a product catalogue; ${fps} fingerprinted${FP ? `, ${throttled} throttled (retry in ${FP_RETRY_DAYS}d)` : ""}.`);
  } finally {
    await sql.end();
    closeAgents();   // keep-alive proxy sockets would otherwise hold the process open
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
