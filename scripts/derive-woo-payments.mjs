#!/usr/bin/env node
/**
 * Derive WooCommerce payment gateways from the plugins we've ALREADY fingerprinted — no probing.
 * Woo payment gateways install as plugins (`woocommerce-gateway-stripe`, `paygate-payweb-…`,
 * `happypay-woocommerce`), so where woo_probe captured the plugin list we can read the gateway
 * straight out of it and fill the `payments` column (semicolon-joined canonical names, same shape
 * as the Shopify checkout probe writes). Marks payments_source='woo_plugin' so it's distinguishable
 * from checkout-verified data.
 *
 *   node --env-file=.env.local scripts/derive-woo-payments.mjs [--commit]
 *
 * Default is a DRY RUN (prints coverage, writes nothing); pass --commit to write.
 *
 * CEILING: homepage plugin detection only sees gateways that enqueue front-end assets, so this
 * catches a minority. The embedded Woo core methods (BACS bank transfer, Cash on Delivery, Cheque)
 * and most gateways only show on the CHECKOUT page — that needs the Woo checkout probe (which reads
 * `payment_method_*` from the checkout form, on the store's own domain, no Shopify-edge budget).
 */
import postgres from "postgres";

const COMMIT = process.argv.includes("--commit");

// Allowlist: plugin-slug pattern -> canonical gateway (as the taxonomy names it). First match wins
// per slug. Anything that matches nothing (side-cart, sidebar, checkout-field-editor, order bumps,
// generic "custom-payment-gateways") is ignored — so noise never becomes a fake gateway.
const GATEWAY = [
  [/paygate|payweb|paysubs|-pw3\b/, "PayGate"],
  [/payfast/, "PayFast"],
  [/peach/, "Peach Payments"],
  [/\byoco\b/, "Yoco"],
  [/ozow/, "Ozow"],
  [/paystack/, "Paystack"],
  [/flutterwave/, "Flutterwave"],
  [/razorpay/, "Razorpay"],
  [/woocommerce-payments\b|woopayments/, "WooPayments"],
  [/\bstripe\b|stripe-payment|stripe-gateway/, "Stripe"],
  [/paypal|angelleye|pymntpl/, "PayPal"],
  [/mollie/, "Mollie"],
  [/klarna/, "Klarna"],
  [/payflex/, "Payflex"],
  [/mobicred/, "Mobicred"],
  [/float-gateway|floatpay/, "Float"],
  [/payjustnow/, "PayJustNow"],
  [/happypay|happy-pay/, "Happy Pay"],
  [/snapscan/, "SnapScan"],
  [/zapper/, "Zapper"],
  [/m-?pesa|mpesa/, "M-Pesa"],
  [/tradesafe/, "TradeSafe"],
  [/iveri/, "iVeri"],
  [/walletdoc/, "WalletDoc"],
  [/hellopay/, "HelloPay"],
  [/\blayup\b|layby/, "Layup"],
  [/amazon-payments|amazon-pay/, "Amazon Pay"],
  [/\badyen\b/, "Adyen"],
  [/\bpayu\b/, "PayU"],
  [/revolut/, "Revolut"],
  [/ikhokha/, "iKhokha"],
  [/\bstitch\b|wigwag/, "Stitch"],
  [/intasend/, "IntaSend"],
  [/pesapal/, "Pesapal"],
];

function gatewaysFor(pluginsCsv) {
  const out = [];
  for (const raw of String(pluginsCsv).split(";")) {
    const slug = raw.trim().toLowerCase();
    if (!slug) continue;
    const hit = GATEWAY.find(([re]) => re.test(slug));
    if (hit && !out.includes(hit[1])) out.push(hit[1]);
  }
  return out;
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3, idle_timeout: 20 });
  try {
    await sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS payments_source TEXT`;
    const rows = await sql`
      SELECT domain, plugins FROM imported_stores
      WHERE lower(platform) = 'woocommerce'
        AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
        AND plugins IS NOT NULL AND plugins <> ''
        AND (payments IS NULL OR payments = '')`;
    console.log(`${rows.length} live Woo stores with plugins and no payments yet${COMMIT ? "" : "  [DRY RUN]"}`);

    const tally = new Map();
    let filled = 0, updated = 0;
    for (const r of rows) {
      const gws = gatewaysFor(r.plugins);
      if (!gws.length) continue;
      filled++;
      for (const g of gws) tally.set(g, (tally.get(g) ?? 0) + 1);
      if (COMMIT) {
        // Stamp payments_checked_at. Without it the Woo path filled `payments` but
        // left the staleness column NULL — so 12,140 ZA Woo stores read as 26%
        // payment coverage but 0% "checked", and nothing downstream could tell
        // WHEN we last looked. Payment-switch detection needs that baseline: with
        // no timestamp there is no "since", so a Woo store changing gateway is
        // undetectable. Still guarded to first-fill only, so this adds no write volume.
        await sql`UPDATE imported_stores SET payments = ${gws.join(";")}, payments_source = 'woo_plugin',
                  payments_checked_at = now()
                  WHERE domain = ${r.domain} AND (payments IS NULL OR payments = '')`;
        updated++;
        if (updated % 50 === 0) process.stdout.write(`\r  wrote ${updated}…`);
      }
    }
    console.log(`\n${filled} stores get ≥1 gateway from plugins${COMMIT ? ` (wrote ${updated})` : ""}`);
    console.log("by gateway:");
    for (const [g, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${g}`);
    if (!COMMIT) console.log("\nDRY RUN — re-run with --commit to write.");
  } finally {
    await sql.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
