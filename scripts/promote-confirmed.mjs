/** promote-confirmed — publish banked non-Shopify stores that are ALREADY confirmed real + live.
 *
 *  Thousands of non-Shopify stores sit published=false yet were long ago liveness-checked
 *  (live_status='active') and classified. reconcile-probed only resolves the platform-NULL "pending"
 *  bucket; these already have a platform, so they linger banked forever. This is pure DB promotion —
 *  no crawl, no cost — gated to stores we can already call real:
 *    • WooCommerce with activity_tier selling/active (a confirmed real shop, not a parked install);
 *    • native ecommerce platforms (Magento/PrestaShop/Shopstar/BigCommerce/Ecwid/…) that are live —
 *      the platform itself means a store.
 *  Mixed site/store platforms (Wix, Squarespace, Webflow, Odoo) are NOT promoted here — they need the
 *  store-vs-brochure crawl (wix-probe-style); they stay banked for that pass.
 *
 *    node --env-file=.env.local scripts/promote-confirmed.mjs [--markets ZA,KE,NG] [--all-markets] [--dry-run]
 */
import postgres from "postgres";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const DRY = process.argv.includes("--dry-run");
const FOCUS = "AO,BW,CI,CM,DZ,EG,ET,GH,KE,LS,LY,MA,MU,MW,MZ,NA,NG,RW,SN,SO,SZ,TN,TZ,UG,ZA,ZM,ZW,JP".split(",");
const markets = process.argv.includes("--all-markets") ? FOCUS : arg("--markets", "ZA,KE,NG").toUpperCase().split(",");
// Native ecommerce platforms: being live is sufficient to call it a store.
const STORE_NATIVE = ["magento", "adobe_commerce", "prestashop", "bigcommerce", "ecwid", "cafe24",
  "ec-cube", "opencart", "shopware", "shopstar", "salesforce commerce cloud", "futureshop", "makeshop", "shopserve"];

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3, connect_timeout: 15 });
try {
  // What we'd promote, by platform (confirmed live + a real-store signal).
  const promotable = sql`NOT published AND live_status = 'active' AND UPPER(country) = ANY(${markets}) AND (
      (lower(platform) = 'woocommerce' AND activity_tier IN ('selling','active'))
      OR lower(platform) = ANY(${STORE_NATIVE})
    )`;
  const preview = await sql.begin(async (q) => { await q`SET LOCAL statement_timeout='90s'`;
    return q`SELECT lower(platform) plat, count(*)::int n FROM imported_stores WHERE ${promotable} GROUP BY 1 ORDER BY n DESC`; });
  const total = preview.reduce((a, r) => a + r.n, 0);
  console.log(`markets: ${markets.join(",")}${markets.length > 5 ? " (focus)" : ""}`);
  console.log(`would promote ${total.toLocaleString()} confirmed-live stores:`);
  for (const r of preview) console.log(`  ${r.plat.padEnd(18)} ${r.n.toLocaleString()}`);
  if (DRY) { console.log("\n[DRY] nothing written."); }
  else {
    const res = await sql.begin(async (q) => { await q`SET LOCAL statement_timeout='120s'`;
      return q`UPDATE imported_stores SET published = true WHERE ${promotable} RETURNING 1`; });
    console.log(`\n→ PROMOTED ${res.length.toLocaleString()} stores to published=true.`);
  }
} finally { await sql.end(); }
