// Does a Wix site sell anything, and what? Pure functions over its homepage app list and sitemap.
//
// Wix lists each installed app in the homepage's viewer model (see platform-addons.mjs wixApps), and
// its sitemap.xml links store-products-sitemap.xml once the Wix Stores catalogue has products.
// Measured 2026-11-28 on 120 ZA/KE/NG Wix leads: no store app → 0 products on all 37; store app →
// products on 30 of 51, the other 21 an installed but empty shop. So the app says "could sell",
// the sitemap says "does".
//
//   products   Wix Stores with products in the sitemap, or a third-party shop / ordering app
//   services   no products, but bookings, tickets, plans, reservations or a pay button
//   empty_shop Wix Stores installed, no products, nothing else that takes money
//   brochure   the app list was read and nothing in it sells
//   unknown    no app list on the page, or a store app with no readable sitemap: leave the row alone

const WIX_STORES = /^(wix stores|online store|wix point of sale|product bundles)$/i;
// Shops whose catalogue the Wix sitemap does not list; their presence is the answer.
const OTHER_SHOP = /ecwid|^e-?commerce store|etsy shop|sell downloads|product pdf & file downloads|wix art store|restaurants orders/i;
const SERVICES = /bookings?\b|events & tickets|pricing plans|online programs|^wix services$|hotels|reservations|tickets?\b|gift cards|pay(pal)? (payment )?button|forms? (builder )?& payments|online payments|vacation rental|calendly|schedulista|calendbook|eat app/i;

/** true / false from a sitemap body; null when there is no usable sitemap. */
export function sitemapHasProducts(xml) {
  if (!xml || !/<(sitemapindex|urlset)\b/i.test(xml)) return null;
  return /store-products-sitemap\.xml/i.test(xml);
}

/** @param apps          app names (wixApps output)
 *  @param appListRead   the page carried a viewer-model app list at all
 *  @param hasProducts   sitemapHasProducts() result, or undefined when not fetched */
export function classifyWix({ apps = [], appListRead = false, hasProducts } = {}) {
  if (!appListRead) return { verdict: "unknown", why: "no app list" };
  const store = apps.filter((a) => WIX_STORES.test(a));
  const shop = apps.filter((a) => OTHER_SHOP.test(a));
  const paid = apps.filter((a) => SERVICES.test(a) && !OTHER_SHOP.test(a));
  if (shop.length) return { verdict: "products", why: shop.join(", ") };
  if (store.length && hasProducts === true) return { verdict: "products", why: "store products in sitemap" };
  if (paid.length) return { verdict: "services", why: paid.join(", ") };
  if (store.length) return hasProducts === false
    ? { verdict: "empty_shop", why: "store app, no products in sitemap" }
    : { verdict: "unknown", why: "store app, sitemap unreadable" };
  return { verdict: "brochure", why: apps.length ? `${apps.length} apps, none sell` : "no business apps" };
}

/** Does this verdict need the sitemap to decide? */
export const needsSitemap = (apps) => apps.some((a) => WIX_STORES.test(a)) && !apps.some((a) => OTHER_SHOP.test(a));
