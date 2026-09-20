/** magento-probe (PROTOTYPE) — payment + confirmation probe for banked Magento / Adobe
 *  Commerce stores.
 *
 *  What we learned building this: unlike Shopify (uniform checkout page) and Woo (uniform
 *  Store API), Magento payment methods live on the CHECKOUT step and its REST/GraphQL cart
 *  endpoints are store-variable — often behind a locale path, a 301, or disabled — so FULL
 *  gateway coverage needs per-store checkout automation (Phase 2). This prototype captures
 *  the cheap, reliable signals now and flags which stores are Phase-2-ready:
 *    1. confirm it's really Magento (many BuiltWith "Magento" labels are stale) + version,
 *    2. homepage-visible EXPRESS gateways (PayPal / Amazon Pay / Apple Pay / Stripe / Adyen
 *       express buttons render on the homepage — a partial but zero-cart payment signal),
 *    3. whether the GraphQL endpoint answers `storeConfig` — the stores where we CAN later
 *       pull available_payment_methods via a guest cart (api_open flag).
 *
 *  Results are BANKED (payments on published=false rows) — not surfaced in insights yet.
 *
 *    node --env-file=.env.local scripts/magento-probe.mjs [--limit 400] [--concurrency 6] [--dry-run]
 */
import postgres from "postgres";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const LIMIT = parseInt(arg("--limit", "400"), 10);
const CONC = parseInt(arg("--concurrency", "6"), 10);
const DRY = process.argv.includes("--dry-run");
const UA = "Mozilla/5.0 (compatible; terrain-radar/1.0; +magento-probe)";

const MAGENTO_MARK = ["magento_", "data-mage-init", "/pub/static/version", "mage/cookies", "x-magento-init"];
const VER_RE = /"version"\s*:\s*"([0-9.]+)"|Magento\/([0-9.]+)/i;
// homepage-visible express / embedded gateway tokens → canonical taxonomy (partial by design).
const GATEWAYS = [
  [/braintree/i, "Braintree"], [/paypal/i, "PayPal"], [/amazon.?pay|amazonpayments/i, "Amazon Pay"],
  [/apple.?pay/i, "Apple Pay"], [/google.?pay/i, "Google Pay"], [/stripe/i, "Stripe"],
  [/adyen/i, "Adyen"], [/klarna/i, "Klarna"], [/afterpay|clearpay/i, "Afterpay"],
  [/authorize\.?net|authorizenet/i, "Authorize.Net"], [/payfast/i, "PayFast"],
  [/\bpayu\b|payumoney/i, "PayU"], [/peach.?payment/i, "Peach Payments"], [/paystack/i, "Paystack"],
  [/\byoco\b/i, "Yoco"], [/\bozow\b/i, "Ozow"], [/flutterwave/i, "Flutterwave"], [/paygate/i, "PayGate"],
  [/mollie/i, "Mollie"], [/razorpay/i, "Razorpay"], [/checkout\.com/i, "Checkout.com"],
];

async function get(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try { return await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": UA }, ...opts }); }
  catch { return null; } finally { clearTimeout(t); }
}

async function mapLimit(items, n, fn) {
  let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  }));
}

async function probe(domain) {
  const r = await get(`https://${domain}/`);
  if (!r || !r.ok) return { domain, ok: false };
  const html = (await r.text().catch(() => "")).slice(0, 800_000);
  const hay = html.toLowerCase();
  const isMagento = MAGENTO_MARK.some((m) => hay.includes(m));
  const gws = [...new Set(GATEWAYS.filter(([re]) => re.test(html)).map(([, n]) => n))];
  let version = (html.match(VER_RE) || [])[1] || (html.match(VER_RE) || [])[2] || null;
  // Magento hides its version on the homepage (security), so try the canonical /magento_version
  // endpoint too — off on most stores, but the reliable source on the minority that leave it on.
  if (!version) {
    const mv = await get(`https://${domain}/magento_version`);
    if (mv && mv.ok) {
      const body = (await mv.text().catch(() => "")).slice(0, 200);
      const m = body.match(/Magento\/([0-9.]+)/i);
      if (m && body.length < 200) version = m[1];   // guard: real endpoint returns a short string, not a page
    }
  }
  // Is the GraphQL endpoint open? (the stores we can later pull full payment methods from)
  const g = await get(`https://${domain}/graphql`, {
    method: "POST", headers: { "User-Agent": UA, "Content-Type": "application/json" },
    body: JSON.stringify({ query: "{storeConfig{store_code base_currency_code}}" }),
  });
  let apiOpen = false;
  if (g && g.ok) { try { apiOpen = !!(await g.json())?.data?.storeConfig; } catch { /* not json */ } }
  return { domain, ok: true, isMagento, gateways: gws, version, apiOpen };
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: Math.min(CONC + 1, 6), idle_timeout: 20 });
  try {
    const rows = await sql`
      SELECT domain FROM imported_stores
      WHERE lower(platform) = 'magento'
        AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
        AND (payments_checked_at IS NULL OR payments_checked_at < now() - interval '30 days')
      ORDER BY estimated_monthly_sales DESC NULLS LAST
      LIMIT ${LIMIT}`;
    console.log(`magento-probe: ${rows.length} Magento stores (conc ${CONC})${DRY ? " [DRY]" : ""}`);

    let confirmed = 0, mismatch = 0, withPay = 0, apiOpen = 0;
    const tally = new Map();
    await mapLimit(rows, CONC, async ({ domain }) => {
      const r = await probe(domain);
      if (!r.ok) return;
      if (r.isMagento) confirmed++; else mismatch++;
      if (r.apiOpen) apiOpen++;
      if (r.gateways.length) { withPay++; for (const g of r.gateways) tally.set(g, (tally.get(g) ?? 0) + 1); }
      if (!DRY) {
        const pay = r.gateways.length ? r.gateways.join("; ") : null;
        // Confirmed Magento graduates to published=true (like Woo after woo_probe) so it surfaces
        // in insights + coverage + leads with its version. Mislabeled rows stay banked (untouched).
        await sql`UPDATE imported_stores SET
          published = ${r.isMagento ? true : sql`published`},
          payments = COALESCE(${pay}, payments),
          platform_version = COALESCE(${r.version}, platform_version),
          payments_checked_at = now()
          WHERE domain = ${domain}`.catch(() => {});
      }
    });
    console.log(`confirmed Magento ${confirmed} · mislabeled ${mismatch} · GraphQL-open (Phase-2 ready) ${apiOpen}`);
    console.log(`homepage express gateways found on ${withPay} stores:`,
      [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(", ") || "(none)");
    console.log("NOTE: homepage express is partial — full Magento gateway coverage needs the guest-cart checkout flow (Phase 2, use the api_open stores).");
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
