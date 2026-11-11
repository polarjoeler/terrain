/** WooCommerce catalogue fingerprinting — the other 42% of the visible base.
 *
 *  Radar's clone graph was Shopify-only because fingerprints come off /products.json, which only
 *  Shopify serves (catalog-enrich.mjs excludes Woo by name for exactly that reason). This lane
 *  fills the SAME store_catalog_fp through WooCommerce's public Store API, so a Woo clone of a
 *  Shopify brand lands in ONE fingerprint space and every existing lens sees it unchanged —
 *  clone-sweep, the four Radar lenses and the cluster classifier need no edit at all.
 *
 *    node --env-file=.env.local scripts/woo-catalog-fp.mjs [--limit 500] [--country ZA,KE] [--all]
 *    node … scripts/woo-catalog-fp.mjs --domains a.co.za,b.co.za   # named stores now, any market
 *    node … scripts/woo-catalog-fp.mjs --limit 20 --dry            # select + report, write nothing
 *
 *  WHAT A RANDOM SAMPLE ACTUALLY RETURNS (24 published ZA/KE/NG Woo stores, 2026-11-10):
 *  38% answered, 42% returned a hard 404, the rest timed out or 500'd. The earlier "200 first try"
 *  reading came from two hand-picked stores and was optimistic — plan for ~40%, not ~100%.
 *  Catalogue sizes are violently skewed: median 12 products, one store at 3,653. What bounds this
 *  lane's disk cost is CAP in lib/catalog-fp.mjs (4,000 hashes per kind per row), not the store
 *  count and not MAX_PRODUCTS — which is why MAX_PRODUCTS now matches CAP and truncates instead of
 *  refusing. Reading past CAP products cannot add a hash the row is able to store.
 *
 *  A 404 is a PERMANENT fact (old WooCommerce, or the REST route disabled), not a throttle. It is
 *  parked NO_API_DAYS forward so the lane stops asking, because a lane that cannot record
 *  exhaustion re-probes its dead stores on every run — the probe-queue-zombie failure.
 *
 *  Self-hosted stores sit on their own hosting, NOT behind Shopify's edge, so this lane does not
 *  spend the shared Shopify rate budget and needs no proxy fan-out. It is still paced per store:
 *  each one is somebody's shop, and the Store API is a courtesy we are not entitled to burst.
 */
import postgres from "postgres";
import { fetchWooCatalog, WooCatalogError } from "./lib/woo-catalog.mjs";
import { buildFp, ensureFpTable, upsertFp, deferFp, FP_MARKETS, FP_STALE_DAYS } from "./lib/catalog-fp.mjs";

const ALL = process.argv.includes("--all");
const DRY = process.argv.includes("--dry");
const flagNum = (name, dflt) => { const i = process.argv.indexOf(name); return i > -1 ? Number(process.argv[i + 1]) : dflt; };
const flagList = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1].split(",").map((s) => s.trim()).filter(Boolean) : null;
};

const LIMIT = ALL ? 0 : flagNum("--limit", 500);
const COUNTRIES = flagList("--country")?.map((c) => c.toUpperCase()) ?? null;
const DOMAINS = flagList("--domains")?.map((d) => d.toLowerCase()) ?? null;
const CONCURRENCY = flagNum("--concurrency", 6);
const PAUSE_MS = flagNum("--pause", 400);
// MAX_PRODUCTS truncates at CAP (lib/catalog-fp.mjs), the point past which a fingerprint row can
// hold nothing more. REFUSE_ABOVE is the separate pathological ceiling — X-WP-Total on page one
// lets us walk away from a 50k-SKU marketplace without paying for it, which the Shopify lane cannot.
const MAX_PRODUCTS = flagNum("--max-products", 4000);
const REFUSE_ABOVE = flagNum("--refuse-above", 50000);
// A transient failure (timeout, 5xx) comes back soon; a missing Store API does not come back at all.
const RETRY_DAYS = 3;
const NO_API_DAYS = 120;

const sql = postgres(process.env.DATABASE_URL, { max: 3, idle_timeout: 20, connect_timeout: 30 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await ensureFpTable(sql);

  // Mirrors catalog-enrich's --fp selection, with the platform test inverted: published + in a
  // market we sell into + never fingerprinted or gone stale. Peach stores first, because the fraud
  // pilot is what this coverage is for (see memory: peach-first-customer).
  const rows = DOMAINS
    ? await sql`SELECT domain, country FROM imported_stores WHERE domain = ANY(${DOMAINS}::text[])`
    : await sql`
      SELECT s.domain, s.country
      FROM imported_stores s
      LEFT JOIN store_catalog_fp f ON f.domain = s.domain
      WHERE s.published = true
        AND lower(s.platform) = 'woocommerce'
        AND upper(s.country) = ANY(${COUNTRIES ?? FP_MARKETS})
        AND (f.domain IS NULL OR f.fp_at < now() - make_interval(days => ${FP_STALE_DAYS}))
      ORDER BY (s.payments ILIKE '%peach%') DESC, s.product_count DESC NULLS LAST, s.domain
      ${LIMIT > 0 ? sql`LIMIT ${LIMIT}` : sql``}`;

  console.log(`Woo fingerprinting ${rows.length.toLocaleString()} stores ` +
    `(concurrency ${CONCURRENCY}, ${PAUSE_MS}ms pause, cap ${MAX_PRODUCTS} products)${DRY ? " — DRY RUN" : ""}…`);
  if (DRY) { console.log(rows.slice(0, 20).map((r) => `  ${r.domain} (${r.country})`).join("\n")); await sql.end(); return; }

  let ok = 0, noApi = 0, tooBig = 0, transient = 0, products = 0;
  let i = 0;
  const worker = async () => {
    while (i < rows.length) {
      const { domain } = rows[i++];
      try {
        const { products: ps, total } = await fetchWooCatalog(domain,
          { maxProducts: MAX_PRODUCTS, refuseAbove: REFUSE_ABOVE, pauseMs: PAUSE_MS });
        // An empty catalogue is a real answer: the store is reachable and sells nothing right now.
        // It is written (n_products 0) so the lane does not re-ask for FP_STALE_DAYS.
        await upsertFp(sql, domain, buildFp(ps), null);
        ok++; products += ps.length;
        console.log(`ok   ${domain} -> ${ps.length} products${total > ps.length ? ` (of ${total}, capped)` : ""}`);
      } catch (err) {
        if (err instanceof WooCatalogError && err.status === 404) {
          await deferFp(sql, domain, -NO_API_DAYS); noApi++;
          console.log(`none ${domain} -> no Store API (parked ${NO_API_DAYS}d)`);
        } else if (err instanceof WooCatalogError && err.status === 413) {
          // Past REFUSE_ABOVE — a marketplace, not a brand. Park it like a missing API: re-asking
          // changes nothing until the ceiling does. Note this is NOT the merely-large case any more:
          // a large catalogue is a prime clone VICTIM, so it gets truncated and fingerprinted.
          await deferFp(sql, domain, -NO_API_DAYS); tooBig++;
          console.log(`big  ${domain} -> ${err.message} (parked ${NO_API_DAYS}d)`);
        } else {
          await deferFp(sql, domain, FP_STALE_DAYS - RETRY_DAYS); transient++;
          console.log(`err  ${domain} -> ${err.message} (retry ${RETRY_DAYS}d)`);
        }
      }
      await sleep(PAUSE_MS);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));

  const pct = rows.length ? Math.round((ok / rows.length) * 100) : 0;
  console.log(`\n✓ Done. ${ok}/${rows.length} fingerprinted (${pct}%), ${products.toLocaleString()} products; ` +
    `${noApi} no Store API, ${tooBig} too large, ${transient} transient (retry ${RETRY_DAYS}d).`);
  await sql.end();
}

main().catch(async (e) => { console.error(e); await sql.end({ timeout: 5 }); process.exit(1); });
