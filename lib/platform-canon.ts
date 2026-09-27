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
  norce: "Norce",
  saleor: "Saleor",
  swell: "Swell",
  commercetools: "commercetools",
  crystallize: "Crystallize",
};

/** Canonical spelling for a raw detector value. Unknown values pass through trimmed,
 *  so a newly-detected platform is never silently dropped — it just lands as-is until
 *  someone adds it above. */
export function canonicalPlatform(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  return CANON[v.toLowerCase()] ?? v;
}
