/** Payment-provider classification + label hygiene — mirrors radar/payments_taxonomy.py.
 *  PSP = gateways/acquirers · BNPL = instalment credit · APM = wallets/rails/cards.
 *
 *  The checkout probe records whatever the checkout calls each option, so the raw
 *  labels are messy: machine tokens (`shopify_payments`), Shopify's test gateway
 *  (`bogus`), app handles (`wigwag-app`), per-locale button captions ("Betaal met
 *  Klarna"), and generic card copy that names no gateway at all ("Pay with Apple |
 *  Google | Card"). canonicalProvider() folds those to one name per gateway and
 *  returns "" for anything that isn't a provider. */

export type PayType = "PSP" | "BNPL" | "APM";

const TYPE: Record<string, PayType> = {
  // PSP — gateways/acquirers
  PayFast: "PSP", Yoco: "PSP", "Peach Payments": "PSP", PayGate: "PSP",
  Stripe: "PSP", Adyen: "PSP", Paystack: "PSP",
  Flutterwave: "PSP", PayPal: "PSP", PayU: "PSP", Stitch: "PSP", iKhokha: "PSP",
  "Shopify Payments": "PSP", Pesapal: "PSP", DPO: "PSP", IntaSend: "PSP",
  OPay: "PSP", Nomba: "PSP", Paga: "PSP", Interswitch: "PSP", "Adumo Online": "PSP",
  QwicPay: "PSP", Airwallex: "PSP", Razorpay: "PSP", Mollie: "PSP",
  "Mercado Pago": "PSP", Paymob: "PSP", Fintoc: "PSP", Payzone: "PSP",
  PayTR: "PSP", Onepay: "PSP", Oceanpayment: "PSP", ONERWAY: "PSP",
  "Global-e Payments": "PSP", Frisbii: "PSP", Dintero: "PSP", "Super Payments": "PSP",
  "Bob Pay": "PSP",
  Klix: "PSP", NjiaPay: "PSP", EasyPay: "PSP", Revolut: "PSP",
  // BNPL — instalment credit
  Payflex: "BNPL", Mobicred: "BNPL", Float: "BNPL", Klarna: "BNPL",
  Afterpay: "BNPL", Affirm: "BNPL", Zip: "BNPL",
  PayJustNow: "BNPL", "Happy Pay": "BNPL", RCS: "BNPL",
  Clearpay: "BNPL", Tabby: "BNPL", Koko: "BNPL", Mintpay: "BNPL", in3: "BNPL",
  FeverTree: "BNPL",
  // APM — wallets, bank rails, mobile money, cards, cash
  "Shop Pay": "APM", "Apple Pay": "APM", "Google Pay": "APM", "Amazon Pay": "APM",
  Ozow: "APM", SnapScan: "APM", Zapper: "APM", "Capitec Pay": "APM", "M-Pesa": "APM",
  "Bank Deposit": "APM", "Cash on Delivery": "APM", "Credit Card": "APM",
  Visa: "APM", Mastercard: "APM", Amex: "APM",
  "Absa Pay": "APM", "Instant EFT": "APM", PayShap: "APM",
  ChipIn: "APM",
  "MTN MoMo": "APM", "Airtel Money": "APM", "Discovery Miles": "APM",
  iDeal: "APM", Bancontact: "APM", SOFORT: "APM", EPS: "APM", "KBC/CBC": "APM",
  Belfius: "APM", Przelewy24: "APM", Trustly: "APM", BLIK: "APM", TWINT: "APM",
  MobilePay: "APM", Vipps: "APM", "PostFinance Card": "APM", "China Union Pay": "APM",
  Bitcoin: "APM", "Crypto.com Pay": "APM", "Solana Pay": "APM", "Crypto: USDC": "APM",
  PayPay: "APM", "Rakuten Pay": "APM", Konbini: "APM",
};

export const PAY_TYPES: PayType[] = ["PSP", "BNPL", "APM"];

/** Canonical gateway names, in the casing the checkout probe emits ("PayFast",
 *  "Instant EFT") — used to recover proper casing from a URL slug. */
export const KNOWN_PROVIDERS: string[] = Object.keys(TYPE);

const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Raw label (lowercased) → canonical gateway. Covers machine tokens, app handles,
 *  and the per-locale/per-app caption variants seen in the live checkout data. */
const ALIASES: Record<string, string> = Object.fromEntries(
  Object.entries({
    "Shopify Payments": ["shopify_payments"],
    Stitch: ["wigwag-app", "wigwag"],
    "Apple Pay": ["applepay"],
    "Google Pay": ["googlepay"],
    IntaSend: ["intasend payments", "intasend payment gateway"],
    DPO: ["dpo pay (pay via card here)"],
    "Adumo Online": ["pay now with adumo online", "adumo online payments"],
    Afterpay: ["afterpay (new)", "afterpay us (new)"],
    ChipIn: ["chipin", "pay with chipin", "chipin • split the cost & pay together", "chipin – group payment"],
    Klarna: [
      "mollie - klarna", "pay with klarna", "bezahle mit klarna", "klarna - betal med klarna",
      "mollie - klarna pay later.", "mollie - klarna pay now.", "mollie - klarna slice it.",
      "klarna slice it", "klarna pay now", "klarna payer en 3 fois sans frais",
      "betaal met klarna", "klarna - flexibel bezahlen",
    ],
    "Mercado Pago": [
      "mercado pago checkout pro", "todos los medios de pago | mercado pago",
      "mercado pago tarjetas", "checkout mercado pago", "mercado pago cuotas sin tarjeta",
      "cuotas sin tarjeta con mercado pago", "activa mercado pago tarjetas",
    ],
    Razorpay: [
      "razorpay direct - credit card", "1razorpay - upi, cards, wallets, nb", "1 razorpay",
      "cards onsite by 1razorpay", "01 cards, upi, nb, wallets by razorpay",
    ],
    PayTR: ["paytr - kredi / banka kartı", "kredi / banka kartı (paytr)"],
    Onepay: ["onepay payment gateway (sri lanka)", "credit / debit card payments (onepay)"],
    Zip: ["zip - flexible payment options", "zip payments au", "zip - au"],
    Affirm: ["affirm - pay over time"],
    Tabby: ["pay later with tabby"],
    in3: ["in3 - pay in 3 installments, 0% interest", "mollie - in3"],
    Koko: ["koko: buy now pay later"],
    Mintpay: ["mintpay | shop now. pay later."],
    Klix: ["klix payments"],
    Frisbii: ["frisbii payments"],
    Dintero: ["dintero checkout"],
    NjiaPay: ["njiapay payments"],
    Paymob: ["paymob.valu", "valu"],
    Payzone: ["payzone maroc", "paiement par carte bancaire via payzone"],
    Oceanpayment: ["oceanpayment(direct)"],
    ONERWAY: ["onerway (direct)"],
    "Global-e Payments": ["global-e onsite payments"],
    Revolut: ["revolut payment gateway", "revolut pay"],
    MobilePay: ["mobilepay online", "vipps/mobilepay"],
    Vipps: ["vipps 2.0"],
    FeverTree: ["fevertree credit", "fevertree finance"],
    PayShap: ["pay with payshap"],
    Bitcoin: ["opennode - bitcoin payments"],
    // Mollie fronts a method — the method is the meaningful label at checkout.
    iDeal: ["mollie - ideal"],
    Bancontact: ["mollie - bancontact"],
    SOFORT: ["mollie - sofort"],
    EPS: ["mollie - eps"],
    "KBC/CBC": ["mollie - kbc/cbc"],
    Belfius: ["mollie - belfius"],
    Przelewy24: ["mollie - przelewy24"],
    Trustly: ["mollie - trustly"],
    "PostFinance E-Finance": ["postfinance e-finance"],
  }).flatMap(([canon, raws]) => raws.map((r) => [key(r), canon] as const)),
);

/** Not gateways: Shopify's test gateway, machine artifacts, and the universal
 *  express-checkout buttons / card icons that appear in almost every storefront
 *  regardless of the actual acquirer — markup detection over-reports them. */
const NON_PROVIDER = new Set([
  "shop pay", "apple pay", "google pay", "amazon pay",
  "visa", "mastercard", "amex", "american express", "credit card",
  "bogus", "ppp-production", "checkout flow", "betalingskort",
]);

/** Words that carry no gateway identity. A label made ONLY of these is a button
 *  caption ("Pay with Apple | Google | Card"), not a provider. */
const GENERIC = new Set([
  "pay", "with", "by", "via", "securely", "the", "a", "or", "and", "of",
  "card", "cards", "credit", "debit", "cheque", "check",
  "apple", "google", "visa", "mastercard", "amex", "diners", "american", "express",
  "buy", "now", "later", "bnpl", "instalments", "installments",
  "eft", "payment", "payments", "method", "methods", "option", "options",
  "additional", "more", "other", "online", "checkout", "flow", "w",
  "tarjeta", "tarjetas", "crédito", "débito", "credito", "debito", "con", "pagos",
  "carte", "crédit", "de", "et", "paiement",
]);

const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const isGenericCaption = (label: string) => {
  const w = words(label);
  return w.length > 0 && w.every((x) => GENERIC.has(x));
};

/** One canonical gateway name for a raw checkout label, or "" if it isn't a
 *  provider (test gateway, machine token, generic card caption). */
export function canonicalProvider(raw: string): string {
  let label = raw.trim();
  if (!label) return "";
  // One app prefixes every option with "w | Pay with X" — unwrap to the method.
  const unwrapped = label.match(/^w\s*\|\s*pay with\s+(.+)$/i);
  if (unwrapped) label = unwrapped[1].trim();

  const k = key(label);
  const aliased = ALIASES[k];
  if (aliased) return aliased;
  if (NON_PROVIDER.has(k)) return "";
  if (isGenericCaption(label)) return "";

  // Recover the taxonomy's casing when the probe recorded a different one.
  return KNOWN_PROVIDERS.find((n) => key(n) === k) ?? label;
}

/** Strip non-provider noise, canonicalise names, and dedupe — preserving order
 *  (which is checkout display order, so position 1 stays position 1). */
export function cleanPayments(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const label = canonicalProvider(raw);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

export function classify(provider: string): PayType {
  return TYPE[canonicalProvider(provider) || provider] ?? "APM";
}

/** Every raw label that should count as this provider — the canonical name plus
 *  its aliases. Lets a SQL query match the messy stored values exactly, with no
 *  substring matching (which over-counts "Credit Card" inside "Mollie - Credit Card"). */
export function providerVariants(provider: string): string[] {
  const canon = canonicalProvider(provider) || provider.trim();
  const out = new Set<string>([key(canon), key(provider)]);
  for (const [raw, c] of Object.entries(ALIASES)) if (c === canon) out.add(raw);
  return [...out];
}
