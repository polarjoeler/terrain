/** Read a WooCommerce catalogue through the public Store API, normalised into the SAME shape as
 *  Shopify's products.json so one fingerprint space covers both platforms.
 *
 *  WHY THIS EXISTS. Catalogue fingerprinting has been Shopify-only because it reads
 *  /products.json, which only Shopify serves. Measured 2026-11-09 across the customer-visible
 *  markets: 59,169 published Shopify stores with 3,124 fingerprinted (5%), against 41,957
 *  published WooCommerce stores with 8 (0.02%). Every store in the live clone graph is Shopify.
 *  So Radar is blind to 42% of the base — and to the likeliest real fraud there is, a cheap
 *  self-hosted Woo clone of a Shopify brand. That case is only detectable if both platforms
 *  normalise into one space, which is the entire point of this module.
 *
 *  WHY THE STORE API IS THE RIGHT DOOR. It is the same public, documented, unauthenticated API the
 *  payments lane already uses for /wp-json/wc/store/v1/cart. No header, UA or TLS tuning — the
 *  catalogue-fingerprint work is explicitly barred from anything that looks like bot-check
 *  circumvention, and nothing here does. Measured on two live ZA Woo stores: 200 on the first try
 *  for both, against Shopify's ~75% 429 rate. It also returns X-WP-Total, so catalogue size is
 *  known from the first page and the giants can be skipped rather than discovered the hard way.
 *
 *  THREE WOO-SPECIFIC TRAPS, each of which silently corrupts matching if missed:
 *
 *   1. Titles arrive HTML-escaped — "Live Resin &#8211; Vape Cart" is a real example. Left
 *      undecoded, a Woo title can never match the same product on Shopify, so the cross-platform
 *      case this module exists for would quietly never fire.
 *   2. SKUs are frequently EMPTY. Shopify fingerprints treat a SKU as identifying; an empty string
 *      shared by thousands of Woo stores would behave exactly like the junk-link classes that
 *      chained 21k unrelated stores into one group in store-groups. Empty SKUs are dropped, never
 *      hashed.
 *   3. Prices are MINOR units as a string ("89900" = R899.00) with the scale in
 *      prices.currency_minor_unit, while Shopify gives a decimal string. Both are normalised to a
 *      decimal string here or price-mirroring never matches across platforms.
 */

const UA = "TerrainBot/1.0 (+https://heyterrain.com/about; catalogue fingerprint)";

/** Minimal HTML-entity decode — Woo returns names escaped (trap 1). Numeric forms plus the five
 *  named entities WordPress actually emits; no dependency for a job that runs on Rex. */
export function decodeEntities(s) {
  if (!s || !s.includes("&")) return s ?? "";
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&"); // last: otherwise &amp;#39; double-decodes
}

/** Minor units → the decimal string Shopify-side fingerprints already use (trap 3). */
export function normalisePrice(prices) {
  if (!prices || prices.price == null) return "";
  const minor = Number(prices.currency_minor_unit ?? 2);
  const raw = String(prices.price);
  if (!/^\d+$/.test(raw)) return raw;              // already decimal
  if (!minor) return raw;
  const pad = raw.padStart(minor + 1, "0");
  return `${pad.slice(0, -minor)}.${pad.slice(-minor)}`;
}

/** One Woo product → the Shopify-shaped record the fingerprint builder expects. */
export function toProduct(p) {
  const sku = typeof p.sku === "string" ? p.sku.trim() : "";
  return {
    title: decodeEntities(p.name ?? ""),
    handle: (p.slug ?? "").trim().toLowerCase(),
    // Trap 2: an empty SKU identifies nothing. Keep the field absent, not blank.
    variants: sku ? [{ sku, price: normalisePrice(p.prices) }] : [{ price: normalisePrice(p.prices) }],
    images: (Array.isArray(p.images) ? p.images : [])
      .map((i) => i?.src).filter(Boolean).map((src) => ({ src })),
  };
}

export class WooCatalogError extends Error {
  constructor(message, status) { super(message); this.name = "WooCatalogError"; this.status = status ?? null; }
}

/** Fetch a Woo catalogue. Returns { products, total, pages } or throws WooCatalogError.
 *
 *  `maxProducts` is a real guard, not politeness theatre: X-WP-Total lets us refuse a 20,000-SKU
 *  catalogue before spending the bandwidth, which the Shopify lane cannot do. */
export async function fetchWooCatalog(domain, {
  perPage = 100, maxProducts = 2000, timeoutMs = 15000, pauseMs = 700, fetchImpl = fetch,
} = {}) {
  const base = `https://${domain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}/wp-json/wc/store/v1/products`;
  const products = [];
  let total = null, pages = 0;

  for (let page = 1; ; page++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(`${base}?per_page=${perPage}&page=${page}`, {
        signal: ctl.signal, redirect: "follow", headers: { "User-Agent": UA, Accept: "application/json" },
      });
    } catch (err) {
      throw new WooCatalogError(err?.name === "AbortError" ? "timeout" : String(err?.message ?? err));
    } finally { clearTimeout(timer); }

    if (!res.ok) {
      // A 404 means the Store API is absent (old Woo, or the REST route disabled) — a fact about
      // the store, not a failure to retry.
      throw new WooCatalogError(res.status === 404 ? "no Store API" : `HTTP ${res.status}`, res.status);
    }
    if (!(res.headers.get("content-type") ?? "").includes("json")) {
      throw new WooCatalogError("non-JSON response"); // parked domains love serving HTML here
    }

    if (total == null) {
      const t = Number(res.headers.get("x-wp-total"));
      total = Number.isFinite(t) && t >= 0 ? t : null;
      if (total != null && total > maxProducts) {
        throw new WooCatalogError(`catalogue too large (${total} products)`, 413);
      }
    }

    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    pages++;
    for (const p of batch) products.push(toProduct(p));

    if (batch.length < perPage) break;
    if (products.length >= maxProducts) break;
    if (total != null && products.length >= total) break;
    await new Promise((r) => setTimeout(r, pauseMs)); // one shared residential IP budget
  }

  return { products, total: total ?? products.length, pages };
}
