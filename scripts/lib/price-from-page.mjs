/** The selling price on a product page: ld+json Product offer, then og/product meta, then Woo/Shopify markup. Rand, not cents. */
import { parseRand } from "./promo-products.mjs";
export function priceFromPage(html) {
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let j; try { j = JSON.parse(m[1].trim()); } catch { continue; }
    const nodes = [].concat(j).flatMap((n) => (n && n["@graph"]) ? n["@graph"] : [n]);
    for (const n of nodes) {
      if (!n || !/Product/i.test([].concat(n["@type"] || []).join(","))) continue;
      for (const o of [].concat(n.offers || [])) {
        const offs = o?.["@type"] === "AggregateOffer" ? [{ price: o.lowPrice }] : [].concat(o?.offers || o || []);
        for (const x of offs) {
          // WooCommerce nests it: offers[].priceSpecification[].price
          const spec = [].concat(x?.priceSpecification || [])[0];
          const v = Number(x?.price ?? x?.lowPrice ?? spec?.price);
          if (v > 0) return { price: v, via: "ld+json" };
        }
      }
    }
  }
  const meta = html.match(/<meta[^>]+(?:property|name)="(?:product:price:amount|og:price:amount)"[^>]+content="([\d.,]+)"/i)
    || html.match(/<meta[^>]+content="([\d.,]+)"[^>]+(?:property|name)="(?:product:price:amount|og:price:amount)"/i);
  if (meta) { const v = Number(meta[1].replace(/,/g, "")); if (v > 0) return { price: v, via: "meta" }; }
  // Woo prints the rand sign as &#82; — drop entities before reading digits, or "82" becomes the price.
  const woo = html.replace(/&#\d+;|&[a-z]+;/gi, " ").match(/<p class="price">([\s\S]{0,600}?)<\/p>/i);
  if (woo) {
    const ins = woo[1].match(/<ins[\s\S]*?(\d[\d,. ]*\d)/i) || woo[1].match(/woocommerce-Price-amount[\s\S]*?(\d[\d,. ]*\d)/i);
    if (ins) { const v = parseRand(ins[1]); if (v) return { price: v, via: "woo" }; }
  }
  return null;
}
