/** reconcile-probed — resolve "pending" candidates against what we've ALREADY probed.
 *
 * The pending bucket (platform NULL + unpublished) is mostly the 2019 BuiltWith Woo import that
 * Lucy has since probed: ~99% came back not-Woo, but their imported_stores row was never updated,
 * so they linger as "pending" forever. This is pure DB reconciliation — no crawl, no probing — so
 * it costs store-discovery nothing:
 *   • a real CMS was detected (Shopify / Woo / Wix / Magento …) → stamp the platform (publish the
 *     Shopify/Woo ones — real stores we'd otherwise miss; bank the rest);
 *   • checked but not a store (no CMS) → left as-is; the coverage page now excludes probed rows
 *     from "pending", so they stop reading as un-worked backlog.
 *
 *   node --env-file=.env.local scripts/reconcile-probed.mjs [--dry-run]
 */
import postgres from "postgres";
const DRY = process.argv.includes("--dry-run");

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3, idle_timeout: 20 });
  try {
    const bare = sql`regexp_replace(i.domain,'^www\\.','')`;
    const PENDING = sql`i.platform IS NULL AND NOT i.published`;

    const [pre] = await sql`
      SELECT count(*)::int pending,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM probe_checked pc WHERE pc.domain=${bare} AND COALESCE(pc.platform,'')<>''))::int with_cms,
        count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM probe_checked pc WHERE pc.domain=${bare}))::int unprobed
      FROM imported_stores i WHERE ${PENDING}`;
    console.log(`pending: ${pre.pending} · with a detected CMS in probe_checked: ${pre.with_cms} · never probed: ${pre.unprobed}`);

    // Preview what we'd capture, by platform.
    const preview = await sql`
      SELECT CASE WHEN lower(pc.platform)='woocommerce' THEN 'WooCommerce' ELSE pc.platform END plat, count(*)::int n
      FROM imported_stores i JOIN probe_checked pc ON pc.domain=${bare}
      WHERE ${PENDING} AND COALESCE(pc.platform,'')<>'' GROUP BY 1 ORDER BY n DESC`;
    console.log("would capture:", preview.map((r) => `${r.plat}=${r.n}`).join(", ") || "(none)");

    if (DRY) { console.log("[DRY] nothing written."); return; }

    const res = await sql`
      UPDATE imported_stores i SET
        platform = CASE WHEN lower(pc.platform)='woocommerce' THEN 'WooCommerce' ELSE pc.platform END,
        published = CASE WHEN pc.platform IN ('Shopify','woocommerce','WooCommerce') THEN true ELSE i.published END
      FROM probe_checked pc
      WHERE pc.domain=${bare} AND ${PENDING} AND COALESCE(pc.platform,'')<>''
      RETURNING i.domain,
        (CASE WHEN pc.platform IN ('Shopify','woocommerce','WooCommerce') THEN 1 ELSE 0 END) AS pub`;
    const published = res.filter((r) => r.pub === 1).length;
    console.log(`reconciled ${res.length} rows (${published} published as Shopify/Woo, ${res.length - published} banked as other CMS).`);
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
