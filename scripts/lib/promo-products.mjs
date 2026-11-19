/**
 * promo-products — pure parsers for promo-products.mjs: the sale products a store shows on its own
 * Black Friday collection page (Shopify) or through its public Store API (WooCommerce).
 * Joel approved showing stores' own product photos on 2026-11-19: they load from the store's CDN,
 * each one links back to the product, and any store can opt out the same day.
 *
 * Shopify collection pages come in two shapes, often both on one page:
 *   - an ld+json ItemList: name, url, image, price (no "was" price)
 *   - product-card HTML: image, title, and usually both the sale and the regular price
 * Both are parsed and merged by product handle.
 */
import { decodeEntities } from "./promo-detect.mjs";

const HANDLE_RE = /\/products\/([a-z0-9][a-z0-9-]{1,120})/gi;

/** "R 1,299.00" / "R1 299,00" / "R799" → 1299 / 1299 / 799 (rand, not cents). */
export function parseRand(s) {
  let t = String(s).replace(/^R\s?/i, "").replace(/\s/g, "");
  if (/,\d{2}$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
  else t = t.replace(/,/g, "");
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}
const AMOUNT_RE = /(?<![A-Za-z0-9])R\s?(\d{1,3}(?:[ ,.]\d{3})+(?:[.,]\d{2})?|\d+(?:[.,]\d{2})?)(?![\d%])/g;

/** Pick a mid-size rendition from a Shopify CDN src/srcset and make it absolute. */
export function shopifyImage(raw, origin) {
  if (!raw) return null;
  const cands = raw.split(",").map((s) => s.trim().split(/\s+/)[0]).filter((u) => /\/cdn\/shop\/|cdn\.shopify\.com/.test(u) && !/\.svg/i.test(u));
  if (!cands.length) return null;
  let u = cands.find((c) => /_(360|400|500|540|600)x/.test(c)) || cands[Math.min(2, cands.length - 1)];
  u = decodeEntities(u);
  if (u.startsWith("//")) u = "https:" + u;
  else if (u.startsWith("/")) u = origin + u;
  return u.replace(/_(large|grande|1024x1024|\d{3,4}x)(?=\.)/, "_540x");
}

// ld+json images come as a string, an ImageObject, or a list of either.
const imgUrl = (x) => (typeof x === "string" ? x : x && typeof x === "object" ? x.url || x.contentUrl || x.src || null : null);
// Theme text sometimes arrives double-encoded (Timberland‚® → Timberland®).
export const tidyTitle = (s) => s.replace(/‚(?=[®™©])/g, "").replace(/Â(?=[®™©])/g, "").replace(/\s+/g, " ").trim();

export function parseLdItemList(html) {
  const out = new Map();
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let j;
    try { j = JSON.parse(m[1]); } catch { continue; }
    for (const node of [].concat(j)) {
      if (node?.["@type"] !== "ItemList") continue;
      for (const li of node.itemListElement || []) {
        const p = li.item || li;
        const h = String(p.url || "").match(/\/products\/([^/?#]+)/)?.[1];
        if (!h) continue;
        const offer = [].concat(p.offers || [])[0] || {};
        out.set(h.toLowerCase(), {
          handle: h.toLowerCase(), title: decodeEntities(String(p.name || "")).trim() || null,
          url: p.url, image: imgUrl([].concat(p.image || [])[0]),
          price: offer.price != null ? Number(offer.price) || null : null,
          currency: offer.priceCurrency || null,
        });
      }
    }
  }
  return out;
}

/** Product cards: one chunk per handle, from its first link to the next handle's first link. */
export function parseShopifyCards(html, origin) {
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<svg[\s\S]*?<\/svg>/gi, " ");
  const firsts = [];
  const seen = new Set();
  for (const m of body.matchAll(HANDLE_RE)) {
    const h = m[1].toLowerCase();
    if (seen.has(h)) continue;
    seen.add(h);
    firsts.push({ h, at: m.index });
  }
  const out = new Map();
  firsts.forEach(({ h, at }, i) => {
    const end = i + 1 < firsts.length ? firsts[i + 1].at : at + 6000;
    // The image often sits just before the card's first link; look back a little for it.
    const chunk = body.slice(Math.max(0, at - 1200), Math.min(end, at + 12000));
    const own = body.slice(at, Math.min(end, at + 12000));
    const img = shopifyImage(own.match(/(?:data-srcset|srcset|data-src|src)="([^"]+)"/)?.[1] || chunk.match(/(?:data-srcset|srcset|data-src)="([^"]+\/cdn\/shop\/[^"]+)"/)?.[1], origin);
    const title = decodeEntities(
      own.match(/data-product-title="([^"]+)"/)?.[1] ||
      own.match(/class="[^"]*(?:card__heading|product-item__title|product-title|product-card__title|title)[^"]*"[^>]*>\s*(?:<a[^>]*>)?\s*([^<]{3,120})</)?.[1] ||
      own.match(/<img[^>]+alt="([^"]{4,120})"/)?.[1] || "").trim();
    const amounts = [...own.slice(0, 5000).matchAll(AMOUNT_RE)].map((a) => parseRand(a[1])).filter((n) => n && n >= 5 && n < 500000);
    const uniq = [...new Set(amounts)].sort((a, b) => a - b);
    // Sale badges ("-30%") usually sit just above the card's link, so look a short way back too.
    const near = body.slice(Math.max(0, at - 400), at) + own.slice(0, 5000);
    const badge = Number(near.match(/-\s?(\d{1,2})\s?%/)?.[1]) || null;
    let price = uniq[0] ?? null, regular = uniq.length >= 2 ? uniq[uniq.length - 1] : null;
    // A "from R99 – R999" range isn't a discount; only trust a pair when it's plausibly was/now.
    if (regular && price && (regular / price > 12)) regular = null;
    out.set(h, { handle: h, title: title || null, url: `${origin}/products/${h}`, image: img, price, regular, badge });
  });
  return out;
}

const pctOf = (price, regular) => (price && regular && regular > price ? Math.round((1 - price / regular) * 100) : null);

/** Merge ld+json and card data; keep products with an image, best discount first. */
export function shopifyProducts(html, origin, { max = 8 } = {}) {
  const ld = parseLdItemList(html);
  const cards = parseShopifyCards(html, origin);
  const handles = ld.size ? [...ld.keys()] : [...cards.keys()];
  const out = [];
  for (const h of handles) {
    const a = ld.get(h) || {}, b = cards.get(h) || {};
    const price = a.price ?? b.price ?? null;
    let regular = b.regular && price && b.regular > price ? b.regular : null;
    let pct = pctOf(price, regular);
    if (!pct && b.badge && b.badge >= 5 && b.badge <= 90) pct = b.badge;
    if (pct !== null && (pct < 5 || pct > 90)) { pct = null; regular = null; }
    const image = a.image ? shopifyImage(String(a.image), origin) || String(a.image).replace(/^\/\//, "https://") : b.image;
    const title = tidyTitle(a.title || b.title || h.replace(/-/g, " "));
    if (!image || !price) continue;
    out.push({ handle: h, title, url: a.url || b.url, image, price, regular, pct, currency: a.currency || "ZAR" });
  }
  // Products on the page with a real discount first, then page order.
  return out.map((p, i) => ({ ...p, i })).sort((x, y) => (y.pct ?? 0) - (x.pct ?? 0) || x.i - y.i).slice(0, max).map(({ i, ...p }) => p);
}

/** WooCommerce Store API: /wp-json/wc/store/v1/products?on_sale=true → products. */
export function wooProducts(json, { max = 8 } = {}) {
  if (!Array.isArray(json)) return [];
  const out = [];
  for (const p of json) {
    const pr = p.prices || {};
    const div = 10 ** (Number(pr.currency_minor_unit ?? 2));
    const price = Number(pr.sale_price ?? pr.price) / div, regular = Number(pr.regular_price) / div;
    const image = p.images?.[0]?.thumbnail || p.images?.[0]?.src || null;
    if (!image || !price || !p.permalink) continue;
    const pct = pctOf(price, regular);
    out.push({
      handle: String(p.slug || p.id), title: decodeEntities(String(p.name || "")).replace(/<[^>]+>/g, "").trim(),
      url: p.permalink, image, price, regular: pct ? regular : null, pct: pct && pct >= 5 && pct <= 90 ? pct : null,
      currency: pr.currency_code || "ZAR",
    });
  }
  return out.sort((x, y) => (y.pct ?? 0) - (x.pct ?? 0)).slice(0, max);
}
