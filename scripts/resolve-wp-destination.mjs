#!/usr/bin/env node
/** resolve-wp-destination — settle "migrated to WordPress" into WooCommerce vs a plain WordPress site.
 *
 *  THE PROBLEM. `verify-liveness.mjs` detects the destination platform from homepage markers only
 *  (`woocommerce`, `wp-content/plugins/woocommerce`, `wc-ajax`), and `probe-cms.mjs` deliberately
 *  "leaves WordPress alone" because WordPress is not itself an ecommerce platform. So a Shopify store
 *  that migrated to WooCommerce but whose HOMEPAGE is a landing page — or that defers Woo's assets —
 *  lands as "WordPress". The result is that WordPress is our single biggest recorded migration
 *  destination (710 events), which would read as "most Shopify stores migrate to WordPress". That is
 *  almost certainly wrong, and it is the first number anyone would screenshot off the Attrition page.
 *
 *  THE DISCRIMINATOR. WooCommerce ships a public Store API at /wp-json/wc/store/v1/products. If it
 *  answers with JSON the site sells through Woo, whatever the homepage looks like. If it 404s the
 *  site is plain WordPress — the store genuinely died as a store rather than migrating.
 *  One request per domain, against the merchant's own origin, so it costs nothing from the shared
 *  Shopify-edge budget.
 *
 *    node --env-file=.env.local scripts/resolve-wp-destination.mjs --dry-run
 *    node --env-file=.env.local scripts/resolve-wp-destination.mjs --apply [--limit 2000] [--concurrency 8]
 */
import postgres from "postgres";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const APPLY = process.argv.includes("--apply");
const LIMIT = parseInt(arg("--limit", "5000"), 10);
const CONC = parseInt(arg("--concurrency", "8"), 10);
const UA = "Mozilla/5.0 (compatible; terrain-radar/1.0; +migration-destination)";

/** Returns "WooCommerce" | "WordPress" | null (unreachable — leave it alone and retry later). */
async function resolveOne(domain) {
  for (const host of [domain, `www.${domain}`]) {
    // v1 is current; the unversioned path still answers on older installs.
    for (const path of ["/wp-json/wc/store/v1/products?per_page=1", "/wp-json/wc/store/products?per_page=1"]) {
      try {
        const r = await fetch(`https://${host}${path}`, {
          headers: { "User-Agent": UA, Accept: "application/json" },
          signal: AbortSignal.timeout(12000), redirect: "follow",
        });
        if (r.ok) {
          const ct = r.headers.get("content-type") || "";
          if (ct.includes("json")) {
            const body = await r.text();
            // An empty catalogue still proves Woo is installed; a WP error object does not.
            if (body.trimStart().startsWith("[")) return "WooCommerce";
          }
          continue;
        }
        // A 404 from a reachable host is real evidence of absence, not a network blip.
        if (r.status === 404) return "WordPress";
      } catch { /* try the next host/path */ }
    }
  }
  return null;
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 4, idle_timeout: 20 });
  try {
    const rows = await sql`SELECT domain FROM imported_stores
      WHERE live_status = 'migrated' AND live_platform = 'WordPress'
      ORDER BY estimated_monthly_sales DESC NULLS LAST LIMIT ${LIMIT}`;
    console.log(`migrated-to-WordPress rows to settle: ${rows.length}${APPLY ? "" : "  [DRY RUN]"}`);
    if (!rows.length) return;

    let i = 0, woo = 0, wp = 0, unknown = 0;
    const worker = async () => {
      while (i < rows.length) {
        const { domain } = rows[i++];
        const verdict = await resolveOne(domain);
        if (verdict === "WooCommerce") woo++; else if (verdict === "WordPress") wp++; else { unknown++; continue; }
        if (APPLY) {
          // churn_log is the event record the Attrition page reads, so correct BOTH.
          await sql`UPDATE imported_stores SET live_platform = ${verdict} WHERE domain = ${domain}`.catch(() => {});
          await sql`UPDATE churn_log SET migrated_to = ${verdict}
            WHERE domain = ${domain} AND status = 'migrated'`.catch(() => {});
        }
        if ((woo + wp + unknown) % 100 === 0) process.stdout.write(`\r  ${woo + wp + unknown}/${rows.length}  woo ${woo} · wp ${wp} · unreachable ${unknown}`);
      }
    };
    await Promise.all(Array.from({ length: CONC }, worker));
    const decided = woo + wp;
    console.log(`\ndone: ${decided} settled — WooCommerce ${woo} (${(woo / Math.max(decided, 1) * 100).toFixed(1)}%), WordPress ${wp} (${(wp / Math.max(decided, 1) * 100).toFixed(1)}%), unreachable ${unknown} (left for a retry)`);
    if (!APPLY) console.log("DRY RUN — pass --apply to write.");
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
