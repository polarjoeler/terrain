/** Is a banked WooCommerce site a real online store? Decided from its own product catalogue.
 *
 *  WHY THE CATALOGUE AND NOT THE HOMEPAGE. Sampled 2026-11-24 (450 ZA sites): homepage regexes for
 *  "cart" and "price" flagged an insurer, a domain registrar and an apartment block as stores. The
 *  WooCommerce Store API (/wp-json/wc/store/v1/products, public, the same door the payments and
 *  fingerprint lanes use) says directly whether products exist, carry a price and can be bought.
 *  Of 100 banked ZA Woo sites, 28 had a catalogue and 21 sold online.
 *
 *  WHAT STILL FOOLS IT, each handled below:
 *   - Theme demo shops: the WooCommerce sample data ("Hoodie with Logo", "WordPress Pennant"…) or
 *     a theme's lorem-ipsum products, left live on a brochure site. ~65% of early catalogue matches
 *     in the clone sweep were exactly this (memory: catalog-fingerprints).
 *   - Quote-only B2B catalogues: real businesses, products listed at price 0 or with no buy button.
 *     Not an online checkout, but a real catalogue: since 2026-11-26 they publish as leads with a
 *     known "no online checkout" payments answer (Joel 11-25: "if there's a catalog but not a store
 *     lets keep them in there"). Any prices they do show must be in the market's currency.
 *   - Foreign demo imports: a ZA site whose catalogue is priced in USD/GBP is almost always an
 *     imported theme demo, so the catalogue currency must match the market. */

/** WooCommerce's own sample-data product names (sample-products.csv) plus common theme demo names. */
const SAMPLE_NAMES = new Set([
  "v-neck t-shirt", "hoodie", "hoodie with logo", "hoodie with pocket", "hoodie with zipper", "t-shirt",
  "t-shirt with logo", "beanie", "beanie with logo", "belt", "cap", "sunglasses", "long sleeve tee", "polo",
  "album", "single", "logo collection", "wordpress pennant", "test product", "sample product", "dummy product",
  "product 1", "product 2", "product name", "simple product", "variable product", "grouped product",
]);
/** Words that only appear in placeholder copy. One is enough to call a product name lorem. */
const LOREM = /\b(lorem|ipsum|dolor sit|consectetur|adipiscing|tincidunt|vestibulum|aliquam|pellentesque|curabitur|fusce|nullam|maecenas)\b/i;
const TEST = /^(test|demo|sample|dummy)\b/i;

/** Market → the currency its real stores price in. A market missing here skips the currency rule. */
export const MARKET_CCY = { ZA: "ZAR", KE: "KES", NG: "NGN", GH: "GHS", EG: "EGP", MA: "MAD", UG: "UGX", TZ: "TZS", RW: "RWF", ZM: "ZMW", BW: "BWP", NA: "NAD", MU: "MUR" };

const decode = (s) => String(s ?? "")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;|&#039;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");

export function isPlaceholderName(name) {
  const n = decode(name).trim().toLowerCase();
  return SAMPLE_NAMES.has(n) || LOREM.test(n) || TEST.test(n);
}

/** Minimum buyable products before a site counts as an online store. */
export const MIN_BUYABLE = 2;

/** One page of /wp-json/wc/store/v1/products → a verdict.
 *  Returns { verdict, products, buyable, currency, placeholder } where verdict is one of:
 *  store | quote_only (priced 0 / no buy button) | tiny (one real product) | demo | wrong_currency | empty */
export function judgeCatalogue(products, country) {
  const ps = Array.isArray(products) ? products : [];
  if (!ps.length) return { verdict: "empty", products: 0, buyable: 0, currency: null, placeholder: 0 };
  const placeholder = ps.filter((p) => isPlaceholderName(p?.name)).length;
  const real = ps.filter((p) => !isPlaceholderName(p?.name));
  const buyable = real.filter((p) => p?.is_purchasable === true && Number(p?.prices?.price) > 0);
  // The currency most buyable products are priced in (one store, one currency, in practice).
  const ccys = {};
  for (const p of buyable) { const c = String(p?.prices?.currency_code ?? "").toUpperCase(); if (c) ccys[c] = (ccys[c] ?? 0) + 1; }
  const currency = Object.entries(ccys).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const base = { products: ps.length, buyable: buyable.length, currency, placeholder };

  // Half or more of the page is sample/lorem/test → the shop is a theme demo, whatever else is in it.
  if (placeholder * 2 >= ps.length) return { verdict: "demo", ...base };
  const want = MARKET_CCY[String(country ?? "").toUpperCase()];
  if (buyable.length < MIN_BUYABLE) {
    if (real.length < MIN_BUYABLE) return { verdict: "tiny", ...base };
    // A catalogue-mode shop still shows prices; a foreign-priced one is an imported demo, not a ZA B2B list.
    const shown = {};
    for (const p of real) { const c = String(p?.prices?.currency_code ?? "").toUpperCase(); if (c && Number(p?.prices?.price) > 0) shown[c] = (shown[c] ?? 0) + 1; }
    const shownCcy = Object.entries(shown).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    if (want && shownCcy && shownCcy !== want) return { verdict: "wrong_currency", ...base, currency: shownCcy };
    return { verdict: "quote_only", ...base, currency: shownCcy };
  }
  if (want && currency !== want) return { verdict: "wrong_currency", ...base };
  return { verdict: "store", ...base };
}

/** A store hidden behind a maintenance / coming-soon page still answers its Store API, so a catalogue
 *  alone says nothing about whether customers can shop. Checked on the homepage before any publish:
 *  the <title> wording, or the markup of the common maintenance plugins (SeedProd, WP Maintenance
 *  Mode, Coming Soon Page, Under Construction). 2026-11-25 dry run: "MadAnt Computers … is under
 *  construction" and "Boland Brand Solutions is coming soon" both had a full priced catalogue. */
const HOLDING_TITLE = /coming soon|under construction|maintenance|launching soon|be right back|site (is )?(currently )?(offline|unavailable)/i;
const HOLDING_MARKUP = /seedprod|wp-maintenance-mode|wpmm-|csp4|coming-soon-page|under-construction-page|cmp-coming-soon|maintenance-mode/i;
export function isHoldingPage(html) {
  const h = String(html ?? "");
  const title = h.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "";
  return HOLDING_TITLE.test(decode(title)) || HOLDING_MARKUP.test(h.slice(0, 200000));
}

/** Tidy a site name for display: strip a dangling separator ("Zimple Web -") and holding-page tails. */
export function tidyName(name) {
  const t = decode(name ?? "")
    .replace(/\s+(is\s+)?(coming soon|under construction)\.?$/i, "")
    .replace(/[\s|:·–—-]+$/u, "").replace(/\s+/g, " ").trim();
  // A "name" with no letters in it ("&rarr;", "|", "2024") is markup debris, not a store name.
  return t && /\p{L}{2}/u.test(decode(t).replace(/&[a-z]+;/gi, "")) ? t : null;
}
