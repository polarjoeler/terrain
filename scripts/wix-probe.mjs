/** wix-probe — the deeper Wix investment. Wix has millions of SITES but only a fraction are
 *  STORES, so raw "Wix" coverage is mostly noise for a commerce product. This separates the
 *  real Wix Stores from brochure sites and captures their payment signal.
 *
 *  Signal (validated): the Wix Stores app is present iff the page carries the Wix eCommerce
 *  app-definition id `1380b703-ce81-ff05-f115-39571d94dfcd` (plus AddToCart controls). A Wix
 *  page WITHOUT it is a brochure site — we tag it activity_tier='not_a_store' so it's filtered
 *  out of any store view (same tier leads-explore already hides), while real stores are kept
 *  and get their payment providers read.
 *
 *  Payments: Wix routes most checkouts through Wix Payments, but ZA/African merchants often add
 *  Payfast / Paystack / Peach / PayPal / Ozow / Stripe — we detect those tokens; a store with a
 *  catalog but no external token is recorded as "Wix Payments" (the default rail).
 *
 *  Banked (published=false rows) — sizing Wix, not yet surfaced in insights.
 *
 *    node --env-file=.env.local scripts/wix-probe.mjs [--limit 500] [--concurrency 8] [--dry-run]
 */
import postgres from "postgres";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const LIMIT = parseInt(arg("--limit", "500"), 10);
const CONC = parseInt(arg("--concurrency", "8"), 10);
const DRY = process.argv.includes("--dry-run");
const UA = "Mozilla/5.0 (compatible; terrain-radar/1.0; +wix-probe)";

const WIX_STORES_APPID = "1380b703-ce81-ff05-f115-39571d94dfcd";     // Wix eCommerce app — the store signal
const STORE_MARKERS = [WIX_STORES_APPID, "wixstores", "addtocart", "\"iscommerce\"", "ecom-platform"];
const GATEWAYS = [
  [/payfast/i, "PayFast"], [/paystack/i, "Paystack"], [/peach.?payment/i, "Peach Payments"],
  [/\bozow\b/i, "Ozow"], [/\byoco\b/i, "Yoco"], [/paypal/i, "PayPal"], [/stripe/i, "Stripe"],
  [/mercado.?pago/i, "Mercado Pago"], [/flutterwave/i, "Flutterwave"], [/\bpayu\b/i, "PayU"],
];

async function get(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try { return await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": UA } }); }
  catch { return null; } finally { clearTimeout(t); }
}
async function mapLimit(items, n, fn) {
  let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  }));
}

async function probe(domain) {
  let html = null;
  for (const u of [`https://${domain}/`, `https://www.${domain}/`]) {
    const r = await get(u);
    if (r && r.ok) { html = (await r.text().catch(() => "")).slice(0, 900_000); break; }
    if (r === null) break;
  }
  if (html == null) return { domain, ok: false };
  const hay = html.toLowerCase();
  const isWix = hay.includes("wixstatic.com") || hay.includes("parastorage.com") || hay.includes("wix.com");
  const isStore = STORE_MARKERS.some((m) => hay.includes(m));
  const gws = [...new Set(GATEWAYS.filter(([re]) => re.test(html)).map(([, n]) => n))];
  // a store with a catalog but no external gateway token → Wix Payments (the default rail)
  if (isStore && !gws.length) gws.push("Wix Payments");
  return { domain, ok: true, isWix, isStore, gateways: gws };
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: Math.min(CONC + 1, 8), idle_timeout: 20 });
  try {
    const rows = await sql`
      SELECT domain FROM imported_stores
      WHERE lower(platform) = 'wix'
        AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
        AND (payments_checked_at IS NULL OR payments_checked_at < now() - interval '30 days')
      ORDER BY estimated_monthly_sales DESC NULLS LAST
      LIMIT ${LIMIT}`;
    console.log(`wix-probe: ${rows.length} Wix domains (conc ${CONC})${DRY ? " [DRY]" : ""}`);

    let stores = 0, sites = 0, notWix = 0, dead = 0;
    const tally = new Map();
    await mapLimit(rows, CONC, async ({ domain }) => {
      const r = await probe(domain);
      if (!r.ok) { dead++; return; }
      if (!r.isWix) notWix++;
      if (r.isStore) { stores++; for (const g of r.gateways) tally.set(g, (tally.get(g) ?? 0) + 1); }
      else sites++;
      if (!DRY) {
        const tier = r.isStore ? "selling" : "not_a_store";
        const pay = r.isStore && r.gateways.length ? r.gateways.join("; ") : null;
        await sql`UPDATE imported_stores SET
          activity_tier = ${tier},
          payments = COALESCE(${pay}, payments),
          payments_checked_at = now()
          WHERE domain = ${domain}`.catch(() => {});
      }
    });
    console.log(`Wix STORES ${stores} · brochure sites ${sites} · not-Wix ${notWix} · unreachable ${dead}`);
    console.log("store payment rails:",
      [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(", ") || "(none)");
    console.log(`→ ${stores} real Wix Stores separated from ${sites} brochure sites (tagged not_a_store).`);
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
