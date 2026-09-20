#!/usr/bin/env node
/**
 * WooCommerce launch dating from the WordPress REST API — the proper source (crt.sh cert dates only
 * reached ~1% of Woo). WordPress exposes the oldest post/page via /wp-json/wp/v2/…?orderby=date&
 * order=asc, and a store's oldest content ≈ when the site went live — the Woo analogue of Shopify's
 * first_product_at. Hits each store's OWN domain, so no Shopify-edge budget.
 *
 *   node --env-file=.env.local scripts/woo-date.mjs [--limit 800] [--concurrency 10] [--dry-run]
 *
 * Sets launched_at + launched_source='wp_oldest'; wp_dated_at marks the attempt (net fails retry).
 * Only fills where there's no launch date already.
 */
import postgres from "postgres";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const LIMIT = parseInt(arg("--limit", "800"), 10);
const CONC = parseInt(arg("--concurrency", "10"), 10);
const DRY = process.argv.includes("--dry-run");
const UA = "Mozilla/5.0 (compatible; terrain-radar/1.0; +launch-dating)";

const TIMEOUT = 12000;
async function get(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try { return await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": UA } }); }
  catch { return null; } finally { clearTimeout(t); }
}

const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s);

/** Oldest content date from the WP REST API — try posts, then pages, then products. Returns a
 *  YYYY-MM-DD launch proxy, or {net:true} on a network failure, or null if nothing datable. */
async function oldestDate(base) {
  let net = false;
  for (const path of ["wp/v2/posts", "wp/v2/pages", "wp/v2/product"]) {
    const r = await get(`${base}/wp-json/${path}?per_page=1&orderby=date&order=asc&_fields=date,date_created`);
    if (!r) { net = true; continue; }
    if (!r.ok) continue;
    const arr = await r.json().catch(() => null);
    if (!Array.isArray(arr) || !arr.length) continue;
    const d = arr[0]?.date || arr[0]?.date_created;
    if (isDate(d)) return d.slice(0, 10);
  }
  return net ? { net: true } : null;
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: Math.min(CONC + 1, 6), idle_timeout: 20 });
  try {
    await sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS wp_dated_at TIMESTAMPTZ`;
    const rows = await sql`
      SELECT domain FROM imported_stores
      WHERE lower(platform) = 'woocommerce' AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
        AND wp_dated_at IS NULL AND launched_at IS NULL
        AND (first_product_at IS NULL OR first_product_at !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}')
      ORDER BY published DESC, activity_tier = 'selling' DESC NULLS LAST, discovered_at DESC NULLS LAST
      LIMIT ${LIMIT}`;
    console.log(`woo-date: ${rows.length} undated Woo stores (concurrency ${CONC})${DRY ? " [DRY RUN]" : ""}`);

    let i = 0, done = 0, dated = 0, none = 0, net = 0;
    const years = new Map();
    async function worker() {
      while (i < rows.length) {
        const { domain } = rows[i++];
        const res = await oldestDate(`https://${domain}`);
        done++;
        if (res && res.net) { net++; }
        else if (res) {
          dated++;
          years.set(res.slice(0, 4), (years.get(res.slice(0, 4)) ?? 0) + 1);
          if (!DRY) await sql`UPDATE imported_stores SET launched_at = ${res}::date, launched_source = 'wp_oldest', wp_dated_at = now()
            WHERE domain = ${domain} AND launched_at IS NULL`.catch(() => {});
        } else {
          none++;
          if (!DRY) await sql`UPDATE imported_stores SET wp_dated_at = now() WHERE domain = ${domain}`.catch(() => {});
        }
        if (done % 50 === 0) process.stdout.write(`\r  ${done}/${rows.length}  dated ${dated}, none ${none}, net-fail ${net}`);
      }
    }
    await Promise.all(Array.from({ length: CONC }, worker));
    console.log(`\ndone. ${dated}/${rows.length} dated, ${none} no-content, ${net} network-failed.`);
    console.log("by launch year:", [...years.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([y, n]) => `${y}:${n}`).join(" "));
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
