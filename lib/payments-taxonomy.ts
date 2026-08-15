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
