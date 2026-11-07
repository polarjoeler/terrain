/** One-off: carry the Brand Audit's old store_fingerprints (JSONB, ~2.7k SA catalogues fetched
 *  Aug–Oct 2026) into store_catalog_fp, so the clone sweep starts from real catalogues instead of
 *  the few dozen products.json reads Shopify lets through now. No fetching.
 *
 *  Only fills stores with no usable fingerprint yet (missing, or parked at n_products = -1); a
 *  fresh fetch always wins. fp_at keeps the old enriched_at, so the --fp lane treats these as due
 *  for refresh — and if Shopify refuses the refresh, deferFp keeps the arrays.
 *
 *   node --env-file=.env.local scripts/migrate-legacy-fp.mjs [--dry-run]
 */
import postgres from "postgres";
import { ensureFpTable, fpFromLegacy, FP_MARKETS } from "./lib/catalog-fp.mjs";

const DRY = process.argv.includes("--dry-run");

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 2, idle_timeout: 20 });
  try {
    await sql`SET statement_timeout = '120s'`;
    await ensureFpTable(sql);
    let seen = 0, wrote = 0, empty = 0;
    for await (const batch of sql`
        SELECT l.domain, l.n_products, l.image_stems, l.skus, l.handles, l.titles, l.price_by_handle, l.enriched_at
        FROM store_fingerprints l
        JOIN imported_stores s ON s.domain = l.domain
        LEFT JOIN store_catalog_fp f ON f.domain = l.domain
        WHERE l.status = 'ok' AND upper(s.country) = ANY(${FP_MARKETS})
          AND (f.domain IS NULL OR f.n_products < 0)`.cursor(200)) {
      const rows = [];
      for (const r of batch) {
        seen++;
        const fp = fpFromLegacy(r);
        if (!fp.img.length && !fp.sku.length && !fp.handle.length) { empty++; continue; }
        const arr = (a) => `{${Array.from(a).join(",")}}`;
        rows.push({ domain: r.domain, n_products: fp.n, img: arr(fp.img), sku: arr(fp.sku), handle: arr(fp.handle),
                    title: arr(fp.title), price: arr(fp.price), fp_at: r.enriched_at });
      }
      if (DRY || !rows.length) { wrote += rows.length; continue; }
      await sql`INSERT INTO store_catalog_fp (domain, n_products, img, sku, handle, title, price, fp_at)
        SELECT domain, n_products, img::int4[], sku::int4[], handle::int4[], title::int4[], price::int4[], fp_at::timestamptz
        FROM jsonb_to_recordset(${sql.json(rows)})
          AS x(domain text, n_products int, img text, sku text, handle text, title text, price text, fp_at text)
        ON CONFLICT (domain) DO UPDATE SET n_products = EXCLUDED.n_products, img = EXCLUDED.img, sku = EXCLUDED.sku,
          handle = EXCLUDED.handle, title = EXCLUDED.title, price = EXCLUDED.price, fp_at = EXCLUDED.fp_at
        WHERE store_catalog_fp.n_products < 0`;
      wrote += rows.length;
    }
    console.log(`${DRY ? "[dry-run] would carry" : "Carried"} ${wrote.toLocaleString()} of ${seen.toLocaleString()} legacy fingerprints (${empty} empty after normalising).`);
  } finally {
    await sql.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
