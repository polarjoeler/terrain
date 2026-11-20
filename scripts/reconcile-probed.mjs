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
 *   node --env-file=.env.local scripts/reconcile-probed.mjs [--dry-run] [--verbose]
 *
 * Every query here is a full-table scan, so a scheduled run does only the two UPDATEs (they report
 * their own counts); the pending breakdown and the per-platform preview run with --dry-run/--verbose.
 */
import postgres from "postgres";
const DRY = process.argv.includes("--dry-run");
// Customer-visible markets (mirror of lib/markets.ts VISIBLE_MARKETS) and the eCommerce-platform rule.
const VISIBLE = ["ZA","KE","NG","EG","MA","GH","TZ","UG","DZ","TN","CI","SN","MU","MZ","CM","BW","AO","NA","RW","ZM","ET","ZW","LY","MW","SO","LS","SZ"];
const ECOMM_PLATFORMS = ["Shopify","EasyOrders","LightFunnels","YouCan","Magento","Ecwid","ecwid","Bumpa","PrestaShop","OpenCart",
  "SureCart","Drupal Commerce","Shopware","SAP Hybris","Gumroad","nopCommerce","Shoplazza","Salesforce Commerce Cloud",
  "Paystack Storefront","ShopStar","Big Cartel","Payhip","WP eCommerce","Easy Digital Downloads","Spree",
  "Joomla (VirtueMart/HikaShop)","BigCommerce","Saleor","Square Space store","CS-Cart","Adobe Commerce","Shopline",
  "Zen Cart / osCommerce","Shift4Shop/3dcart","Salla","Tiendanube/Nuvemshop","Medusa","WP EasyCart","Centra","Weebly/Square Online"];
const BUILDER_PLATFORMS = ["Odoo","Wix","Squarespace","Webflow","GoDaddy","GoDaddy Website Builder","Duda","SITE123","Jimdo","Framer","Strikingly"];
const REPORT = DRY || process.argv.includes("--verbose");

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3, idle_timeout: 20 });
  try {
    const bare = sql`regexp_replace(i.domain,'^www\\.','')`;
    const PENDING = sql`i.platform IS NULL AND NOT i.published`;

    if (REPORT) {
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
    }

    if (DRY) {
      console.log("[DRY] pending-bucket: nothing written.");
    } else {
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
    }

    // SECOND reconciliation — the checkout-verified gap. A store the woo-checkout probe COMPLETED
    // (payments_source='woo_checkout'/'woo_plugin', a gateway read) is a confirmed live selling store,
    // but nothing promoted it: the probe stamps the gateway and leaves published untouched, and the
    // pending-bucket reconcile above only looks at platform-NULL rows via the CMS classifier. So every
    // woo-checkout confirmation silently stayed hidden (≈1k ZA/KE/NG at first run). Publish them here —
    // the gateway IS the liveness proof — excluding anything since marked dead/migrated or not_a_store.
    const VERIFIED = sql`NOT published
      AND payments_source IN ('woo_checkout','woo_plugin')
      AND payments IS NOT NULL AND payments <> ''
      AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
      AND activity_tier IS DISTINCT FROM 'not_a_store'`;
    if (DRY) {
      const [vp] = await sql`SELECT count(*)::int n FROM imported_stores WHERE ${VERIFIED}`;
      console.log(`[DRY] would publish ${vp.n} checkout-verified stores (payments_source woo_checkout/woo_plugin).`);
    } else {
      const vres = await sql`UPDATE imported_stores SET published = true WHERE ${VERIFIED}`;
      console.log(`published ${vres.count} checkout-verified stores (were confirmed-live but hidden).`);
    }

    // THIRD — the eCommerce-platform rule (Joel 11-20: "if we think they are selling / eComm, we
    // publish"). An African store identified on a shop platform is a store; liveness catches the dead
    // ones afterwards. Before this, ~10k sat hidden because no lane ever confirmed them (5.8k Shopify
    // that verify-liveness never reached, plus DNS/HTML-identified YouCan/EasyOrders/Magento/… from the
    // sweep that confirm-other-cms's hosting_provider rule couldn't pass). Website builders count only
    // where the sweep's classifier also saw cart/checkout/product markers. Left OUT on purpose:
    // WooCommerce (the plugin sits on plenty of non-shops — it waits for the checkout probe), X-Cart
    // (its 'xcart' signature matched clinics and wine estates), VTEX (crux-ranked misreads), Selar
    // (banked by decision), and account./mail./cpanel.-style hosts that aren't storefronts.
    const ECOMM = sql`NOT published AND upper(country) = ANY(${VISIBLE})
      AND domain NOT LIKE 'www.%' AND domain NOT LIKE '%/%'
      AND domain !~ '^(account|accounts|mail|webmail|cpanel|admin|checkout|login|auth|cdn|api)\\.'
      AND (live_status IS NULL OR live_status NOT IN ('dead','migrated')) AND activity_tier IS DISTINCT FROM 'not_a_store'
      AND (platform = ANY(${ECOMM_PLATFORMS}) OR (platform = ANY(${BUILDER_PLATFORMS}) AND source = 'crux-sweep'))`;
    if (DRY) {
      const [ep] = await sql`SELECT count(*)::int n FROM imported_stores WHERE ${ECOMM}`;
      console.log(`[DRY] would publish ${ep.n} African stores on an eCommerce platform.`);
    } else {
      const eres = await sql`UPDATE imported_stores SET published = true WHERE ${ECOMM}`;
      console.log(`published ${eres.count} African stores on an eCommerce platform.`);
    }
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
