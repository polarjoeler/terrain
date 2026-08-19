/** Payment-provider classification — mirrors radar/payments_taxonomy.py.
 *  PSP = gateways/acquirers · BNPL = instalment credit · APM = wallets/rails/cards. */

export type PayType = "PSP" | "BNPL" | "APM";

const TYPE: Record<string, PayType> = {
  PayFast: "PSP", Yoco: "PSP", "Peach Payments": "PSP", PayGate: "PSP",
  Ozow: "PSP", Stripe: "PSP", Adyen: "PSP", Paystack: "PSP",
  Flutterwave: "PSP", PayPal: "PSP", PayU: "PSP", Stitch: "PSP", iKhokha: "PSP",
  Payflex: "BNPL", Mobicred: "BNPL", Float: "BNPL", Klarna: "BNPL",
  Afterpay: "BNPL", Affirm: "BNPL", Zip: "BNPL",
  PayJustNow: "BNPL", "Happy Pay": "BNPL", RCS: "BNPL",
  "Shop Pay": "APM", "Apple Pay": "APM", "Google Pay": "APM", "Amazon Pay": "APM",
  SnapScan: "APM", Zapper: "APM", "Capitec Pay": "APM", "M-Pesa": "APM",
  "Bank Deposit": "APM", "Cash on Delivery": "APM", "Credit Card": "APM",
  Visa: "APM", Mastercard: "APM", Amex: "APM",
  "Absa Pay": "APM", "Instant EFT": "APM",
  PayPay: "APM", "Rakuten Pay": "APM", Konbini: "APM",
};

export const PAY_TYPES: PayType[] = ["PSP", "BNPL", "APM"];

export function classify(provider: string): PayType {
  return TYPE[provider] ?? "APM";
}

// Shopify's universal express-checkout buttons and generic card icons appear in
// almost every store's storefront markup regardless of the actual gateway, so
// markup detection over-reports them and inflates the provider list. They aren't
// meaningful "providers" (the real acquirer — e.g. Paystack — is only visible at
// checkout), so drop them from provider views.
const NON_PROVIDER = new Set([
  "Shop Pay", "Apple Pay", "Google Pay", "Amazon Pay",
  "Visa", "Mastercard", "Amex", "Credit Card",
]);

/** Strip non-provider noise (universal wallets/card icons) and dedupe. */
export function cleanPayments(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const label = raw.trim();
    if (!label || NON_PROVIDER.has(label) || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}
