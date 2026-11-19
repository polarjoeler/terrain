/**
 * storefront-classify — is this homepage a store, and on what platform? Read from the HTML alone.
 *
 * Shared by ingest-ranked.mjs (one CrUX market at a time) and crux-sweep.mjs (every market). Moved
 * here unchanged from ingest-ranked on 2026-11-19 so both read a page the same way.
 */
/* ---- platform detection (from homepage HTML) ------------------------------ */
// Ordered: first match wins. 'native' = store by platform; 'mixed' = needs store markers.
export const PLATFORMS = [
  { name: "Shopify",        kind: "native", sig: ["cdn.shopify.com", "cdn/shop/", "myshopify.com", "shopify.theme", "x-shopify"] },
  { name: "WooCommerce",    kind: "native", sig: ["woocommerce", "wp-content/plugins/woocommerce", "wc-block"] },
  // NB: avoid "mage/" — it is a substring of "image/" and matches almost every site.
  { name: "Magento",        kind: "native", sig: ["data-mage-init", "mage-cache-storage", "/static/version", "/frontend/magento", "magento_", "mage/cookies"] },
  { name: "Adobe Commerce", kind: "native", sig: ["adobe commerce", "magento_commerce"] },
  { name: "BigCommerce",    kind: "native", sig: ["cdn11.bigcommerce.com", "bigcommerce.com/s-", "stencil-utils"] },
  { name: "PrestaShop",     kind: "native", sig: ["prestashop", "/modules/ps_"] },
  { name: "OpenCart",       kind: "native", sig: ["catalog/view/theme", "route=product&", "index.php?route="] },
  { name: "Shopware",       kind: "native", sig: ["shopware", "cms-element-"] },
  { name: "Ecwid",          kind: "native", sig: ["ecwid", "app.ecwid.com", "ecwid_script"] },
  { name: "Big Cartel",     kind: "native", sig: ["bigcartel.com", "data-bc-"] },
  { name: "ShopStar",       kind: "native", sig: ["shopstar.co.za", "_tillyoudrop_session"] },
  // Enterprise/other ecommerce platforms found by examine-custom in the 'custom' bucket — these run
  // much of the retail head (Makro, Clicks, Superbalist, Bash, Cotton On, Puma) that we were missing.
  { name: "Salesforce Commerce Cloud", kind: "native", sig: ["demandware", "dwstatic", "/on/demandware", "dwcdn.net"] },
  { name: "SAP Hybris",     kind: "native", sig: ["yacceleratorstorefront", "/_ui/responsive", "hybris"] },
  { name: "VTEX",           kind: "native", sig: ["vtexassets.com", "vteximg.com", "vtex.render-server", "vtexcommercestable"] },
  { name: "Spree",          kind: "native", sig: ["data-spree", "/spree/", "spree_"] },
  { name: "X-Cart",         kind: "native", sig: ["x-cart", "xcart"] },
  { name: "GoDaddy",        kind: "mixed",  sig: ["img1.wsimg.com", "websites.godaddy", "/ds/web/"] },
  // More platforms the custom-bucket reclassify surfaced — Shoplazza (cross-border dropshipping, big
  // in Africa) + nopCommerce, and the African creator-commerce tools Selar & Bumpa.
  { name: "Shoplazza",      kind: "native", sig: ["shoplazza", "myshoplaza"] },
  { name: "nopCommerce",    kind: "native", sig: ["nopcommerce"] },
  { name: "Selar",          kind: "native", sig: ["selar.co"] },
  { name: "Bumpa",          kind: "native", sig: ["getbumpa", "bumpa.shop"] },
  { name: "Wix",            kind: "mixed",  sig: ["wixstatic.com", "x-wix-", "wix-warmup", "wixcode"] },
  { name: "Squarespace",    kind: "mixed",  sig: ["squarespace.com", "static1.squarespace", "squarespace-cdn"] },
  { name: "Webflow",        kind: "mixed",  sig: ["webflow.io", "assets.website-files.com", "data-wf-"] },
  { name: "Odoo",           kind: "mixed",  sig: ["odoo", "web/static/src"] },
];
export const STORE_MARKERS = [
  "add to cart", "addtocart", "add-to-cart", "add_to_cart", "/cart", "checkout", "data-product",
  "product-grid", "is-commerce", "shopping-cart", "basket", "data-product-id",
  // structured-data / meta signals — catch JS SPAs (e.g. takealot) whose raw HTML has no cart text
  '"@type":"product"', '"@type": "product"', '"@type":"offer"', '"@type":"itemlist"',
  '"@type":"store"', '"@type":"onlinestore"', 'og:type" content="product', 'property="product:price',
  // builder-specific COMMERCE fingerprints — Wix/Squarespace/Webflow render their store client-side,
  // so a commerce storefront often has none of the generic cart text above in its raw HTML. These
  // tokens appear only when the builder's ecommerce product is active (not on a brochure site), so
  // they rescue real builder stores the "mixed" gate was dropping as not_store.
  "wixstores", "wix-ecommerce",                          // Wix Stores
  "sqs-add-to-cart", "squarespace-commerce", "commerce-cart",  // Squarespace Commerce
  "w-commerce", "wf-ecommerce",                          // Webflow Ecommerce
];
export const GATEWAYS = [
  [/payfast/i, "PayFast"], [/paystack/i, "Paystack"], [/peach.?payment/i, "Peach Payments"],
  [/\bozow\b/i, "Ozow"], [/\byoco\b/i, "Yoco"], [/paypal/i, "PayPal"], [/stripe/i, "Stripe"],
  [/flutterwave/i, "Flutterwave"], [/\bpayu\b/i, "PayU"], [/\bmpesa\b/i, "M-Pesa"],
];

// Pure-domain pre-filter: cut the obvious non-stores before spending a fetch on them.
export function nonStoreDomain(d) {
  if (/\.(gov|edu|mil)(\.[a-z]{2,3})?$/.test(d)) return true;          // governments, schools, military
  if (/\.ac\.[a-z]{2,3}$/.test(d)) return true;                        // universities (.ac.za, .ac.uk)
  if (/\.gov\.[a-z]{2,3}$/.test(d)) return true;
  if (/(porn|xvideos|xnxx|xhamster|rule34|\bsex\b|hentai|camsoda|onlyfans|\bixxx\b|\bxxx\b)/.test(d)) return true;
  return GLOBAL_BLOCK.has(d);
}
// High-traffic global/utility sites that rank everywhere but are never a ZA ecommerce LEAD.
export const GLOBAL_BLOCK = new Set([
  "facebook.com","google.com","youtube.com","instagram.com","tiktok.com","twitter.com","x.com","whatsapp.com",
  "linkedin.com","reddit.com","pinterest.com","wikipedia.org","spotify.com","netflix.com","microsoft.com",
  "apple.com","amazon.com","airbnb.co.za","airbnb.com","tripadvisor.co.za","tripadvisor.com","booking.com",
  "livescore.com","livescore.in","livescore.cz","soccerway.com","soccervista.com","flashscore.com",
  "ilovepdf.com","canva.com","office.com","bing.com","yahoo.com","duckduckgo.com","telegram.org",
  "github.com","stackoverflow.com","lg.com","samsung.com","roblox.com","discord.com","twitch.tv",
  "news24.com","iol.co.za","timeslive.co.za","ewn.co.za","sabcnews.com","dailymaverick.co.za",
]);

export function classify(html) {
  const hay = html.toLowerCase();
  let platform = null, kind = null;
  for (const p of PLATFORMS) if (p.sig.some((s) => hay.includes(s))) { platform = p.name; kind = p.kind; break; }
  const hasStoreMarkers = STORE_MARKERS.some((m) => hay.includes(m));
  const gateways = [...new Set(GATEWAYS.filter(([re]) => re.test(html)).map(([, n]) => n))];
  // native platform → store; mixed → store only with markers; none → 'custom' only with real store
  // markers. A payment gateway ALONE is NOT enough: betting/booking/donation sites all carry one
  // (Ozow/Stripe) without being retail stores — require cart/checkout/product/structured-data.
  let verdict, outPlatform = platform;
  if (kind === "native") verdict = "store";
  else if (kind === "mixed") verdict = hasStoreMarkers ? "store" : "not_store";
  else if (hasStoreMarkers) { verdict = "custom"; outPlatform = "custom"; }
  else verdict = "not_store";
  return { verdict, platform: outPlatform, gateways };
}

