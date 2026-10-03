/** probe-cms — confirm + promote banked non-Shopify stores across ALL CMSs (generalises wix-probe).
 *
 *  The banked backlog (published=false) holds classified non-Shopify stores that were never confirmed
 *  live / never promoted. This fetches each homepage ONCE (own-domain → not Shopify-edge rate-limited)
 *  and decides:
 *    • native ecommerce platforms (Magento/PrestaShop/BigCommerce/Ecwid/OpenCart/Shopware/ShopStar) —
 *      being live is enough; the platform itself means a store → promote;
 *    • mixed site/store platforms (Wix/Squarespace/Webflow/Odoo) — require store markers (cart /
 *      checkout / add-to-cart) so brochure sites aren't surfaced → promote only real stores;
 *    • unreachable → mark dead.
 *  Reads payment providers off the page while we're there. Publishes real live stores; tags brochures
 *  not_a_store; leaves WordPress (not an ecommerce platform) alone.
 *
 *    node --env-file=.env.local scripts/probe-cms.mjs [--markets ZA,KE,NG] [--limit 2000] [--concurrency 8] [--dry-run]
 */
import postgres from "postgres";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const LIMIT = parseInt(arg("--limit", "2000"), 10);
const CONC = parseInt(arg("--concurrency", "8"), 10);
const DRY = process.argv.includes("--dry-run");
const MARKETS = arg("--markets", "ZA,KE,NG").toUpperCase().split(",");
const UA = "Mozilla/5.0 (compatible; terrain-radar/1.0; +probe-cms)";

// Platforms we confirm here (native = store by platform; mixed = needs store markers).
const NATIVE = new Set(["magento", "adobe_commerce", "prestashop", "bigcommerce", "ecwid", "opencart", "shopware", "shopstar"]);
const MIXED = new Set(["wix", "squarespace", "webflow", "odoo"]);
const TARGET = [...NATIVE, ...MIXED];
const STORE_MARKERS = ["add to cart", "addtocart", "add-to-cart", "/cart", "checkout", "data-product", "/shop", "is-commerce", "add_to_cart"];
const GATEWAYS = [
  [/payfast/i, "PayFast"], [/paystack/i, "Paystack"], [/peach.?payment/i, "Peach Payments"],
  [/\bozow\b/i, "Ozow"], [/\byoco\b/i, "Yoco"], [/paypal/i, "PayPal"], [/stripe/i, "Stripe"],
  [/mercado.?pago/i, "Mercado Pago"], [/flutterwave/i, "Flutterwave"], [/\bpayu\b/i, "PayU"], [/\bmpesa\b/i, "M-Pesa"],
];

async function get(url) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12000);
  try { return await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": UA } }); }
  catch { return null; } finally { clearTimeout(t); }
}
async function probe(domain, platform) {
  let html = null;
  for (const u of [`https://${domain}/`, `https://www.${domain}/`]) {
    const r = await get(u);
    if (r && r.ok) { html = (await r.text().catch(() => "")).slice(0, 900_000); break; }
    if (r === null) break;
  }
  if (html == null) return { ok: false };
  const hay = html.toLowerCase();
  const isStore = NATIVE.has(platform) ? true : STORE_MARKERS.some((m) => hay.includes(m));
  const gws = [...new Set(GATEWAYS.filter(([re]) => re.test(html)).map(([, n]) => n))];
  return { ok: true, isStore, gateways: gws };
}
async function mapLimit(items, n, fn) {
  let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: Math.min(CONC + 1, 8), idle_timeout: 20 });
try {
  const rows = await sql`
    SELECT domain, lower(platform) AS platform FROM imported_stores
    WHERE NOT published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
      AND lower(platform) = ANY(${TARGET}) AND UPPER(country) = ANY(${MARKETS})
      AND (live_checked_at IS NULL OR live_checked_at < now() - interval '30 days')
    ORDER BY discovered_at DESC NULLS LAST LIMIT ${LIMIT}`;
  console.log(`probe-cms: ${rows.length} banked stores (${MARKETS.join(",")}, conc ${CONC})${DRY ? " [DRY]" : ""}`);
  let promoted = 0, brochure = 0, dead = 0; const byPlat = new Map(); const tally = new Map();
  await mapLimit(rows, CONC, async ({ domain, platform }) => {
    const r = await probe(domain, platform);
    if (!r.ok) { dead++; if (!DRY) await sql`UPDATE imported_stores SET live_status='dead', live_checked_at=now() WHERE domain=${domain}`.catch(() => {}); return; }
    if (r.isStore) {
      promoted++; byPlat.set(platform, (byPlat.get(platform) ?? 0) + 1);
      for (const g of r.gateways) tally.set(g, (tally.get(g) ?? 0) + 1);
      const pay = r.gateways.length ? r.gateways.join("; ") : null;
      if (!DRY) await sql`UPDATE imported_stores SET published=true, live_status='active',
        activity_tier=COALESCE(activity_tier,'selling'), payments=COALESCE(${pay}, payments),
        live_checked_at=now(), first_verified_live_at=COALESCE(first_verified_live_at, now()) WHERE domain=${domain}`.catch(() => { promoted--; });
    } else {
      brochure++;
      if (!DRY) await sql`UPDATE imported_stores SET activity_tier='not_a_store', live_status='active', live_checked_at=now() WHERE domain=${domain}`.catch(() => {});
    }
  });
  console.log(`${DRY ? "would promote" : "PROMOTED"} ${promoted} real stores · brochure ${brochure} · unreachable→dead ${dead}`);
  console.log("by platform:", [...byPlat.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p}=${n}`).join(", ") || "(none)");
  console.log("payment rails:", [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(", ") || "(none)");
} finally { await sql.end(); }
