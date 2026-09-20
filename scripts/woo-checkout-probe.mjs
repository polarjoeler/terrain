#!/usr/bin/env node
/**
 * Woo checkout probe — read a WooCommerce store's ENABLED payment gateways WITHOUT touching Shopify.
 * Woo exposes the Store API on the store's own domain: GET /wp-json/wc/store/v1/cart returns a
 * `payment_methods` array of gateway IDs. An empty cart under-reports (some gateways only appear
 * when payment is due), so we add one in-stock product first (Store API nonce + cart-token), then
 * re-read. Falls back to parsing the checkout page HTML for stores with the Store API disabled.
 * Gateway IDs (bacs, cod, stripe, payfast, ppcp-gateway, woocommerce_payments, …) map to canonical
 * names and land in `payments` (payments_source='woo_checkout'). This captures the EMBEDDED core
 * methods (BACS/COD) and every plugin gateway — the full picture, unlike plugin-slug derivation.
 *
 * Each request hits the STORE's own domain (a different host per store), so there's no shared
 * Shopify-edge rate budget and no single-host throttle — safe to run from any machine.
 *
 *   node --env-file=.env.local scripts/woo-checkout-probe.mjs [--limit 300] [--concurrency 6] [--dry-run]
 */
import postgres from "postgres";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const LIMIT = parseInt(arg("--limit", "300"), 10);
const CONC = parseInt(arg("--concurrency", "6"), 10);
const DRY = process.argv.includes("--dry-run");
const UA = "terrain-radar/1.0 (woo payment probe; joelbronkowski@gmail.com)";

// WooCommerce gateway ID / plugin token -> canonical gateway (taxonomy casing). First match wins.
const GATEWAY = [
  [/paygate|payweb|paysubs|pw3/, "PayGate"],
  [/payfast/, "PayFast"],
  [/peach/, "Peach Payments"],
  [/ozow/, "Ozow"],
  [/paystack/, "Paystack"],
  [/flutterwave/, "Flutterwave"],
  [/razorpay/, "Razorpay"],
  [/woocommerce_payments|woopayments|woocommerce-payments/, "WooPayments"],
  [/stripe/, "Stripe"],
  [/ppcp|paypal|ppec/, "PayPal"],
  [/mollie/, "Mollie"],
  [/klarna/, "Klarna"],
  [/payflex/, "Payflex"],
  [/mobicred/, "Mobicred"],
  [/float/, "Float"],
  [/payjustnow/, "PayJustNow"],
  [/happy[_-]?pay/, "Happy Pay"],
  [/snapscan/, "SnapScan"],
  [/zapper/, "Zapper"],
  [/m[_-]?pesa/, "M-Pesa"],
  [/tradesafe/, "TradeSafe"],
  [/iveri/, "iVeri"],
  [/walletdoc/, "WalletDoc"],
  [/hellopay/, "HelloPay"],
  [/layup|layby/, "Layup"],
  [/amazon[_-]?pay/, "Amazon Pay"],
  [/adyen/, "Adyen"],
  [/payulatam|\bpayu/, "PayU"],
  [/revolut/, "Revolut"],
  [/ikhokha/, "iKhokha"],
  [/stitch|wigwag/, "Stitch"],
  [/intasend/, "IntaSend"],
  [/pesapal/, "Pesapal"],
  // gateway IDs the Store API returns wrapped in underscores/class names (\b boundaries fail on
  // `class_yoco_wc_payment_gateway`), plus SA/Africa gateways seen in the field.
  [/yoco/, "Yoco"],
  [/callpay/, "CallPay"],
  [/adumo/, "Adumo Online"],
  [/njiapay/, "NjiaPay"],
  [/\bipay\b|ipayafrica|ipay_/, "iPay"],
  // embedded WooCommerce core methods (the ones with no plugin fingerprint)
  [/^bacs$|bank[_-]?transfer|direct[_-]?bank/, "Bank Transfer"],
  [/^cod$|cash[_-]?on[_-]?delivery/, "Cash on Delivery"],
  [/^cheque$|^check$/, "Cheque"],
];

const mapGateways = (ids) => {
  const out = [];
  for (const raw of ids) {
    const id = String(raw).trim().toLowerCase();
    if (!id) continue;
    const hit = GATEWAY.find(([re]) => re.test(id));
    if (hit && !out.includes(hit[1])) out.push(hit[1]);
  }
  return out;
};

const TIMEOUT = 15000;
async function get(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    return await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": UA, ...(opts.headers || {}) }, ...opts });
  } finally { clearTimeout(t); }
}

/** Store API path: read payment_methods, enriching by adding one in-stock product to a cart. */
async function storeApiProbe(base) {
  let r;
  try { r = await get(`${base}/wp-json/wc/store/v1/cart`); } catch { return { net: true }; }
  if (r.status === 404) return null;                    // Store API absent → try HTML
  if (!r.ok) return { net: r.status >= 500 };
  let cart;
  try { cart = await r.json(); } catch { return null; }
  if (!cart || !Array.isArray(cart.payment_methods)) return null;
  const methods = new Set(cart.payment_methods);
  const nonce = r.headers.get("nonce") || r.headers.get("x-wc-store-api-nonce");
  const cartToken = r.headers.get("cart-token");

  // Enrich: add one purchasable simple product, then re-read (empty carts hide payment-due gateways).
  if (nonce) {
    try {
      const pr = await get(`${base}/wp-json/wc/store/v1/products?per_page=10&type=simple`);
      if (pr.ok) {
        const prods = await pr.json().catch(() => []);
        const p = (Array.isArray(prods) ? prods : []).find((x) => x?.is_purchasable && x?.is_in_stock && x?.id);
        if (p) {
          const add = await get(`${base}/wp-json/wc/store/v1/cart/add-item`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Nonce: nonce, ...(cartToken ? { "Cart-Token": cartToken } : {}) },
            body: JSON.stringify({ id: p.id, quantity: 1 }),
          });
          const tok2 = add.headers.get("cart-token") || cartToken;
          if (add.ok) {
            const c2 = await get(`${base}/wp-json/wc/store/v1/cart`, { headers: tok2 ? { "Cart-Token": tok2 } : {} });
            if (c2.ok) { const j2 = await c2.json().catch(() => null); for (const m of j2?.payment_methods || []) methods.add(m); }
          }
        }
      }
    } catch { /* enrichment best-effort; keep whatever the empty cart gave */ }
  }
  return { ids: [...methods], via: "store_api" };
}

/** Fallback: parse the checkout page HTML for gateway ids (classic `payment_method_<id>` inputs
 *  and gateway plugin asset paths). Best-effort — classic checkout may render nothing on an empty cart. */
async function htmlProbe(base) {
  for (const path of ["/checkout/", "/checkout", "/cart/"]) {
    let r;
    try { r = await get(`${base}${path}`); } catch { continue; }
    if (!r.ok) continue;
    const html = await r.text().catch(() => "");
    if (!html) continue;
    const ids = new Set();
    for (const m of html.matchAll(/payment_method_([a-z0-9_-]+)/gi)) ids.add(m[1].toLowerCase());
    for (const m of html.matchAll(/wp-content\/plugins\/([a-z0-9-]+)/gi)) ids.add(m[1].toLowerCase());
    if (ids.size) return { ids: [...ids], via: "html" };
  }
  return null;
}

async function probe(domain) {
  const base = `https://${domain}`;
  const s = await storeApiProbe(base);
  if (s?.net) return { net: true };
  let res = s && s.ids ? s : null;
  if (!res) { const h = await htmlProbe(base); if (h) res = h; }
  if (!res) return { checked: true, gateways: [] };     // reachable, nothing found → mark, don't retry
  return { checked: true, gateways: mapGateways(res.ids), via: res.via };
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: Math.min(CONC + 1, 6), idle_timeout: 20 });
  try {
    await sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS woo_checkout_at TIMESTAMPTZ`;
    // Target undated payments first, then upgrade plugin-derived to checkout-verified. Skip anything
    // already checkout-probed (woo_checkout_at set); a network failure leaves it null → retried.
    const rows = await sql`
      SELECT domain FROM imported_stores
      WHERE lower(platform) = 'woocommerce' AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
        AND woo_checkout_at IS NULL
        AND (payments IS NULL OR payments = '' OR payments_source = 'woo_plugin')
      -- Real, live storefronts first (selling/active) + published: they actually have the Store API
      -- and enabled gateways, so we spend the probe where the yield is, not on parked/dormant imports.
      ORDER BY (activity_tier IN ('selling','active')) DESC NULLS LAST, published DESC, discovered_at DESC NULLS LAST
      LIMIT ${LIMIT}`;
    console.log(`woo-checkout-probe: ${rows.length} stores (concurrency ${CONC})${DRY ? " [DRY RUN]" : ""}`);

    let i = 0, dated = 0, none = 0, net = 0, done = 0;
    const tally = new Map();
    async function worker() {
      while (i < rows.length) {
        const { domain } = rows[i++];
        const res = await probe(domain);
        done++;
        if (res.net) { net++; }                          // leave woo_checkout_at null → retry later
        else if (res.gateways.length) {
          dated++;
          for (const g of res.gateways) tally.set(g, (tally.get(g) ?? 0) + 1);
          if (!DRY) await sql`UPDATE imported_stores SET payments = ${res.gateways.join(";")},
                    payments_source = 'woo_checkout', woo_checkout_at = now() WHERE domain = ${domain}`.catch(() => {});
        } else {
          none++;
          if (!DRY) await sql`UPDATE imported_stores SET woo_checkout_at = now() WHERE domain = ${domain}`.catch(() => {});
        }
        if (done % 25 === 0) process.stdout.write(`\r  ${done}/${rows.length}  dated ${dated}, none ${none}, net-fail ${net}`);
      }
    }
    await Promise.all(Array.from({ length: CONC }, worker));
    console.log(`\ndone. ${dated} stores got gateways, ${none} reachable-but-none, ${net} network-failed (retry).`);
    console.log("by gateway:");
    for (const [g, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${g}`);
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
