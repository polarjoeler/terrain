/** Catalog enrichment — capture clean product data from each store's public
 *  /products.json (footprint-free: no cart, no checkout, just a public read).
 *  Fills product_count + avg_product_price (AOV) so the revenue estimator and
 *  Lead Fit Score have real signals instead of the noisy imported figures.
 *
 *  Value-ranked, resumable (skips stores already enriched), bounded worker pool.
 *   node --env-file=.env.local scripts/catalog-enrich.mjs [--limit 3000] [--all]
 */
import postgres from "postgres";

const ALL = process.argv.includes("--all");
const li = process.argv.indexOf("--limit");
const LIMIT = ALL ? 0 : li > -1 ? Number(process.argv[li + 1]) : 3000;
// Low concurrency + a per-request pause: hitting products.json too fast gets our IP
// HTTP 429'd (Shopify/Cloudflare throttle), which was tanking the hit rate.
const POOL = 6, CONCURRENCY = 4, PAUSE_MS = 250;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// note = null on success; retriable=true means don't mark it done (try again next run:
// rate-limits and transient errors clear), false means terminal (not Shopify / gone).
async function fetchCatalog(domain) {
  try {
    const res = await fetch(`https://${domain}/products.json?limit=250`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(15000), redirect: "follow",
    });
    if (res.status === 429 || res.status >= 500) return { note: `http_${res.status}`, retriable: true };
    if (!res.ok) return { note: `http_${res.status}`, retriable: false };
    const j = await res.json().catch(() => null);
    if (!j || !Array.isArray(j.products)) return { note: "not_shopify_json", retriable: false };
    const prices = [];
    for (const p of j.products) for (const v of p.variants ?? []) { const pr = parseFloat(v.price); if (pr > 0) prices.push(pr); }
    const avg = prices.length ? Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100 : null;
    // Own-sourced launch date: the earliest product's publish date ≈ when the store
    // went live. Independent of any vendor's "first_seen".
    const dates = j.products.map((p) => p.published_at || p.created_at).filter(Boolean).sort();
    const launched = dates.length ? String(dates[0]).slice(0, 10) : null;
    return { count: j.products.length, avg, launched, note: null };   // 250 = full page (lower bound)
  } catch (e) {
    return { note: e.name === "TimeoutError" ? "timeout" : "error", retriable: e.name === "TimeoutError" };
  }
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: POOL, idle_timeout: 20 });
  try {
    await sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS catalog_checked_at TIMESTAMPTZ`;
    const rows = await sql`
      SELECT domain FROM imported_stores
      WHERE published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
        AND catalog_checked_at IS NULL
      ORDER BY estimated_monthly_sales DESC NULLS LAST, created_at DESC
      ${LIMIT > 0 ? sql`LIMIT ${LIMIT}` : sql``}`;
    console.log(`Catalog-enriching ${rows.length.toLocaleString()} stores (concurrency ${CONCURRENCY})…`);

    let i = 0, ok = 0, done = 0;
    async function worker() {
      while (i < rows.length) {
        const { domain } = rows[i++];
        const r = await fetchCatalog(domain);
        if (r.note == null) {
          await sql`UPDATE imported_stores SET product_count = ${r.count},
                    avg_product_price = COALESCE(${r.avg}, avg_product_price),
                    launched_at = COALESCE(${r.launched}, launched_at),
                    launched_source = CASE WHEN ${r.launched}::text IS NOT NULL AND launched_at IS NULL THEN 'earliest_product' ELSE launched_source END,
                    catalog_checked_at = now()
                    WHERE domain = ${domain}`;
          ok++;
        } else if (!r.retriable) {
          // Terminal (not Shopify / gone) — mark done so we don't keep trying it.
          await sql`UPDATE imported_stores SET catalog_checked_at = now() WHERE domain = ${domain}`;
        } // retriable (429/5xx/timeout): leave catalog_checked_at NULL → picked up next run
        if (++done % 200 === 0) process.stdout.write(`\r  ${done}/${rows.length}  (${ok} with catalog)`);
        await sleep(PAUSE_MS);
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    console.log(`\n✓ Done. ${ok}/${rows.length} returned a product catalogue.`);
  } finally {
    await sql.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
