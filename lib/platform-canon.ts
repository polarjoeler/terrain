/** One canonical spelling per platform, applied at the landing boundary.
 *
 *  Detectors disagree on case because they were written separately: woo_probe.py
 *  emits "BASE" (the vendor's own styling, ベイス) while bulk_classify.py and the
 *  Common Crawl seeders emit "base". That split 1,943 JP stores across two rows, so
 *  every `GROUP BY platform` — insights, digests, coverage — counted BASE twice and
 *  reported it as two smaller platforms.
 *
 *  Normalising here rather than in each detector means a new probe can emit whatever
 *  the vendor calls itself and still land consistently. Keys are lowercased.
 */
const CANON: Record<string, string> = {
  // the collision this file exists for
  base: "BASE",
  "base ec": "BASE",
  // spelling variants seen across detectors
  woocommerce: "WooCommerce",
  wordpress: "WordPress",
  shopify: "Shopify",
  wix: "Wix",
  magento: "Magento",
  "adobe commerce": "Magento",
  shopware: "Shopware",
  centra: "Centra",
  squarespace: "Squarespace",
  bigcommerce: "BigCommerce",
  prestashop: "PrestaShop",
  webflow: "Webflow",
  ecwid: "Ecwid",
  odoo: "Odoo",
  cafe24: "Cafe24",
  "ec-cube": "EC-CUBE",
  eccube: "EC-CUBE",
  shopstar: "ShopStar",
  salesforcecommercecloud: "Salesforce Commerce Cloud",
  "salesforce commerce": "Salesforce Commerce Cloud",
  "salesforce commerce cloud": "Salesforce Commerce Cloud",
  // JP platforms — keep the lowercase vendor styling, just pin it so it cannot drift
  colorme: "colorme",
  storesjp: "storesjp",
  makeshop: "makeshop",
  shopserve: "shopserve",
  futureshop: "futureshop",
  w2: "w2",
  vtex: "VTEX",
  bagisto: "Bagisto",
  norce: "Norce",
  saleor: "Saleor",
  swell: "Swell",
  commercetools: "commercetools",
  crystallize: "Crystallize",
  // hosted platforms added to shopify-radar/hosted_platforms.json on 2026-11-13 — pinned so a
  // detector's casing can't split them (names match rows already in the DB where those exist)
  "big cartel": "Big Cartel",
  bigcartel: "Big Cartel",
  shopline: "Shopline",
  shoplazza: "Shoplazza",
  "tiendanube/nuvemshop": "Tiendanube/Nuvemshop",
  tiendanube: "Tiendanube/Nuvemshop",
  nuvemshop: "Tiendanube/Nuvemshop",
  "weebly/square online": "Weebly/Square Online",
  weebly: "Weebly/Square Online",
  "square online": "Weebly/Square Online",
  "godaddy website builder": "GoDaddy Website Builder",
  youcan: "YouCan",
  lightfunnels: "LightFunnels",
  easyorders: "EasyOrders",
  "easy orders": "EasyOrders",
  salla: "Salla",
  duda: "Duda",
  site123: "SITE123",
  strikingly: "Strikingly",
  jimdo: "Jimdo",
};

/** Canonical spelling for a raw detector value. Unknown values pass through trimmed,
 *  so a newly-detected platform is never silently dropped — it just lands as-is until
 *  someone adds it above. */
export function canonicalPlatform(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  return CANON[v.toLowerCase()] ?? v;
}

/** PLATFORM FAMILIES — platforms that are the same underlying stack.
 *
 *  WooCommerce, SureCart and WP eCommerce are WordPress PLUGINS, not platforms a store can
 *  "migrate to" from WordPress. Swapping between them, or losing the plugin's homepage markers
 *  while keeping WordPress's, is a plugin change on one stack — not a replatform.
 *
 *  This matters because migrations are detected by comparing a recorded `platform` against a
 *  freshly probed `live_platform`, and the probe reads homepage markers only. `verify-liveness`
 *  tests WooCommerce's markers ("woocommerce", "wc-ajax") BEFORE WordPress's ("wp-content"), so a
 *  Woo store whose homepage defers its assets — or is showing an under-construction/maintenance
 *  page — falls through to "WordPress" and read as a migration. Measured 2026-11-18 across the
 *  visible markets, that fiction was 199 of the 745 platform changes Insights was counting:
 *  woocommerce→wordpress 182, woocommerce→surecart 11, surecart→wordpress 4, and 2 via
 *  WP eCommerce — about a third of the headline "wordpress gained" figure.
 *
 *  Genuine cross-stack moves are untouched: shopify→wordpress (228) and shopify→woocommerce (202)
 *  are real departures from Shopify, magento→wordpress (8) is a real replatform, and
 *  woocommerce→shopify (9) is a real arrival.
 *
 *  Deciding WHICH WordPress-family plugin a store ended on is a different question, answered by a
 *  request to Woo's public Store API — see scripts/resolve-wp-destination.mjs. */
export const WORDPRESS_FAMILY = [
  "wordpress", "woocommerce", "surecart", "wp ecommerce", "wp-ecommerce", "wpecommerce",
];

/** The stack a platform belongs to, for deciding whether a change of label is a real move.
 *  Everything outside a known family is its own family, so an unrecognised platform is never
 *  silently merged into another. */
export function platformFamily(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return null;
  return WORDPRESS_FAMILY.includes(v) ? "wordpress" : v;
}

/** True when two platform labels name the same underlying stack, so moving between them is not a
 *  migration. Two nulls are NOT the same family: with nothing recorded we never knew where the
 *  store was, and that is a classification question, not a move. */
export function samePlatformFamily(a: string | null | undefined, b: string | null | undefined): boolean {
  const fa = platformFamily(a), fb = platformFamily(b);
  return fa !== null && fb !== null && fa === fb;
}
