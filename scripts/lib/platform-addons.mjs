// Installed add-ons read from a storefront's own markup, per platform. Pure functions over HTML.
//
// Every pattern is anchored to a path or JSON key only that platform emits, so the readers run on
// every page whatever the row's `platform` label says (labels are often wrong: 19 of 30 sampled
// ZA/KE/NG "Magento" leads were Squarespace sites).
//
//   Wix       the viewer model names each installed app: "appDefinitionName":"Fera Reviews"
//   Magento 2 static asset paths name each module: /static/frontend/<Vendor>/<theme>/en_US/Klevu_Search/…
//   Magento 1 theme only: /skin/frontend/<package>/<theme>/
//   OpenCart  catalog/view/javascript/<module>/, route=extension/<type>/<code>, catalog/view/theme/<theme>/
//   Odoo      /website/info lists installed apps (one extra GET, see odooInfoApps)
//
// PrestaShop /modules/<slug>/ and WordPress wp-content/plugins/<slug> stay in deep-enrich's cmsPlugins.

const decode = (s) => String(s)
  .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&amp;/g, "&").replace(/&#0*39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&#0*38;/g, "&")
  .replace(/\s+/g, " ").trim();

// A path on another site's host is that site's, not this store's (a ubuy.ae widget embedded on a ZA
// page carries /skin/frontend/default/ubuycom-v1/). Relative paths, the store's own host and generic
// CDNs count; any other host does not.
const CDN = /(^|\.)(cloudfront\.net|akamaized\.net|fastly\.net|b-cdn\.net|azureedge\.net|cdn77\.org|jsdelivr\.net|bunnycdn\.com|imgix\.net|kxcdn\.com)$/;
export function ownsHost(host, ownHost) {
  if (!host) return true;
  if (!ownHost) return false;
  const h = host.toLowerCase().replace(/^www\./, ""), o = ownHost.toLowerCase().replace(/^www\./, "");
  const label = o.split(".")[0];
  return h === o || h.endsWith("." + o) || o.endsWith("." + h) || CDN.test(h) || (label.length >= 4 && h.split(".").includes(label));
}
// Either a full URL (host captured) or a relative path starting right after a quote, "(" or "=" —
// never a bare path picked out of the middle of someone else's URL.
const HOST = String.raw`(?:(?:https?:)?\/\/([a-z0-9.-]+)|(?<=["'(=,\s]))`;

// ---- Wix ----------------------------------------------------------------------------------------
// Platform plumbing present on most Wix sites whatever the merchant installed (measured on 63 ZA/KE/NG
// Wix leads: ShoutOut 61, Old Forms 54, CMS 51, Data Binding 51, Checkout & Orders 47 …) and the
// members-area sub-apps that come with any login. Business apps (Wix Stores, Bookings, Blog, Events,
// Pricing Plans, Restaurants …) and every third-party app are kept.
const WIX_PLUMBING = new Set([
  "shoutout (legacy)", "old wix forms and payments", "wix cms", "data binding", "checkout & orders",
  "subscriptions", "wallet", "my subscriptions", "my addresses", "profile card", "member account info",
  "members", "members area", "members about", "members widget", "members notifications settings",
  "wix members area", "wix members area notifications", "[migrated] - wix members", "followers",
  "wix forms platform", "wix pro gallery", "wix video", "category header", "search suggestions box",
  "loyalty - my rewards", "wix webmcp",
]);
export function wixApps(html) {
  const out = new Set();
  for (const m of (html || "").matchAll(/"appDefinitionName":"((?:[^"\\]|\\.){2,80})"/g)) {
    const name = decode(m[1]);
    if (!name || WIX_PLUMBING.has(name.toLowerCase())) continue;
    if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(name)) continue;          // internal slugs: ricos-viewer-ooi, sm-platform-app
    if (/\b(dev|test|staging)\b/i.test(name)) continue;            // "FAQ Widget - dev"
    out.add(name);
  }
  return [...out];
}

// ---- Magento ------------------------------------------------------------------------------------
// Modules that ship inside Magento Open Source itself; their presence says nothing about the merchant.
const MAGENTO_BUNDLED = /^(Magento|PayPal_Braintree|Amazon|Klarna|Vertex|Dotdigitalgroup|Temando|MSP|Yotpo_Yotpo|Fastly_Cdn|Adobe|Laminas|Zend)(_|$)/;
const MAGENTO_STOCK_THEME = /^Magento\/(luma|blank|backend)$/;
export function magentoAddons(html, ownHost) {
  const h = html || "";
  const mods = new Set();
  const STATIC = String.raw`\/?(?:[A-Za-z0-9_.-]+\/)*static\/(?:version\d+\/)?frontend\/([A-Za-z0-9_]+\/[A-Za-z0-9_-]+)\/[a-z]{2}_[A-Z]{2}\/`;
  let theme2 = null, ownStatic = false;
  for (const m of h.matchAll(new RegExp(HOST + STATIC + String.raw`(?:([A-Z][A-Za-z0-9]+_[A-Z][A-Za-z0-9]+)\/)?`, "g"))) {
    if (!ownsHost(m[1], ownHost)) continue;
    ownStatic = true;
    if (!theme2 && !MAGENTO_STOCK_THEME.test(m[2])) theme2 = m[2];
    if (m[3]) mods.add(m[3]);
  }
  // x-magento-init / requirejs component names: "Amasty_Base/js/…"
  if (ownStatic || /text\/x-magento-init/.test(h))
    for (const m of h.matchAll(/["'\s]([A-Z][A-Za-z0-9]+_[A-Z][A-Za-z0-9]+)\/(?:js|template|css|web)\//g)) mods.add(m[1]);
  const plugins = [...mods].filter((x) => !MAGENTO_BUNDLED.test(x)).sort();
  let theme = theme2;
  // Magento 1 theme only with Magento 1's own scripts on the page: other sites' widgets carry skin paths.
  if (!theme && /\/js\/mage\/|Mage\.Cookies|varien\/js\.js/.test(h)) for (const m of h.matchAll(new RegExp(HOST + String.raw`\/?(?:[A-Za-z0-9_.-]+\/)*skin\/frontend\/([a-z0-9_-]+\/[a-z0-9_-]+)\/`, "gi")))
    if (ownsHost(m[1], ownHost) && !/^(base|default)\/default$/i.test(m[2])) { theme = m[2].toLowerCase(); break; }
  return { plugins, theme };
}

// ---- OpenCart -----------------------------------------------------------------------------------
// Libraries OpenCart ships in catalog/view/javascript (bootstrap 27/31, font-awesome 26, common 22 …).
const OC_STOCK_JS = new Set(["bootstrap", "font-awesome", "fontawesome", "common", "jquery", "summernote", "moment",
  "datetimepicker", "css", "js", "image", "images", "fonts", "lib", "theme", "zoom", "magnific", "swiper", "owl-carousel",
  // generic front-end libraries a theme bundles, not store add-ons
  "slick", "owlcarousel", "owl.carousel", "fancybox", "magnific-popup", "lightbox", "colorbox", "select2", "nivo-slider",
  "flexslider", "jquery-ui", "isotope", "lazyload", "wow", "animate", "modernizr", "html5shiv", "respond", "aos",
  "countdown", "elevatezoom", "photoswipe", "masonry", "imagesloaded", "sweetalert", "toastr", "popper", "slider"]);
const OC_STOCK_ROUTE = /^(captcha\/basic|extension\/[a-z_]+|module\/(featured|bestseller|latest|special|category|account|carousel|slideshow|banner|html|information))$/;
const OC_STOCK_THEME = new Set(["default", "css", "javascript", "image", "stylesheet"]);
const slug = (s) => s.toLowerCase().replace(/\.(min\.)?(js|css)$/, "").replace(/\.(min)$/, "");
export function opencartAddons(html, ownHost) {
  const h = (html || "").replace(/&amp;/g, "&");
  const out = new Set();
  for (const m of h.matchAll(new RegExp(HOST + String.raw`\/?(?:[A-Za-z0-9_.-]+\/)*catalog\/view\/javascript\/([A-Za-z0-9_.-]+)`, "g"))) {
    if (!ownsHost(m[1], ownHost)) continue;
    const s = slug(m[2]);
    if (s.length >= 3 && !OC_STOCK_JS.has(s) && !/^jquery[.-]/.test(s) && !/\d+\.\d+|[-.]min$|^dd_belatedpng/.test(s)) out.add(s);
  }
  for (const m of h.matchAll(/route=extension\/([a-z_]+\/[a-z0-9_]+)/g))
    if (!OC_STOCK_ROUTE.test(m[1])) out.add(m[1].split("/")[1]);
  for (const m of h.matchAll(/[/"']extension\/([a-z0-9_]{3,40})\/catalog\//g)) if (m[1] !== "opencart") out.add(m[1]);   // OC 4
  const t = [...h.matchAll(new RegExp(HOST + String.raw`\/?(?:[A-Za-z0-9_.-]+\/)*catalog\/view\/theme\/([A-Za-z0-9_-]+)\/`, "g"))]
    .filter((m) => ownsHost(m[1], ownHost)).map((m) => m[2]).find((x) => !OC_STOCK_THEME.has(x.toLowerCase()));
  return { plugins: [...out].sort(), theme: t ? t.toLowerCase() : null };
}

// ---- Odoo ---------------------------------------------------------------------------------------
export const ODOO_INFO_PATH = "/website/info";
export const looksOdoo = (html, platform) =>
  /odoo/i.test(platform || "") || /\/web\/assets\/[^"']*web\.assets_frontend|odoo\.__session_info__|<meta name="generator" content="Odoo/i.test(html || "");
/** Installed apps from Odoo's /website/info page (Sales, CRM, eCommerce, and third-party modules). */
export function odooInfoApps(html) {
  const h = html || "";
  const i = h.search(/Installed Applications/i);
  if (i < 0) return [];
  const out = new Set();
  for (const m of h.slice(i, i + 200_000).matchAll(/<dt[^>]*>\s*(?:<a[^>]*>)?\s*([^<]{2,60}?)\s*(?:<\/a>)?\s*<\/dt>/g)) {
    const name = decode(m[1]);
    if (name && name.toLowerCase() !== "website") out.add(name);
  }
  return [...out];
}

/** Every platform reader over one homepage. theme = the first non-stock theme any reader found. */
export function platformAddons(html, ownHost) {
  const mg = magentoAddons(html, ownHost), oc = opencartAddons(html, ownHost);
  return { plugins: [...new Set([...wixApps(html), ...mg.plugins, ...oc.plugins])], theme: mg.theme || oc.theme || null };
}
