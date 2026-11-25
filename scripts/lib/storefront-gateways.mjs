/**
 * storefront-gateways — read a store's payment gateways from its own pages' MARKUP, and say whether
 * the page is a working shop at all. Pure functions, no I/O (other-cms-payments.mjs does the fetching).
 *
 * Built 2026-11-25 for the visible stores on platforms no checkout probe covers (ShopStar, OpenCart,
 * PrestaShop, Odoo, Squarespace, Ecwid, custom builds…). render-enrich --payments-gap had been their
 * only check, and it found a gateway on 4 of 400: it reads the rendered homepage text, and a
 * gateway rarely names itself there. A 42-store sample read the evidence these sites DO carry:
 *
 *   hosts    every URL in the page (script/iframe/link/img src, inline JS strings): a PSP's SDK or
 *            badge loads from its own domain (js.yoco.com, www.payfast.co.za, *.oppwa.com).
 *   modules  the platform's payment-module paths: PrestaShop /modules/<name>/, OpenCart
 *            extension/…/payment/<code>, Odoo /payment_<provider>/static, WordPress plugins.
 *   badges   an <img> whose file name or alt/title names the gateway (payfast-logo.png, alt="Yoco").
 *
 * Never plain page text. Bare words are what made the older probes noisy: "eft" and "float" match CSS,
 * "stripe" matches a striped dress, "PayFast" is ALSO a Pakistani gateway that ticketing sites name
 * in copy. Names are canonical lib/payments-taxonomy.ts spellings.
 */

const SUB = (s) => new RegExp(s);
// Gateway table. host: tested against each URL's hostname. token: tested against image file names
// and alt/title text (lowercased). module: tested against a platform payment-module name.
export const GATEWAYS = [
  { name: "PayFast",        host: /(^|\.)payfast\.(co\.za|io)$/,                 token: SUB("payfast"),               module: /payfast/ },
  { name: "Yoco",           host: /(^|\.)yoco\.(com|co\.za)$/,                   token: /(^|[^a-z])yoco([^a-z]|$)/,     module: /yoco/ },
  { name: "Ozow",           host: /(^|\.)(ozow\.com|i-pay\.co\.za)$/,           token: SUB("ozow"),                  module: /ozow|ipay_?eft/ },
  { name: "Peach Payments", host: /(^|\.)(peachpayments\.com|oppwa\.com)$/,     token: /peach[\s_-]?payments/,        module: /peach/ },
  { name: "PayGate",        host: /(^|\.)paygate\.co\.za$/,                      token: SUB("paygate"),               module: /paygate|payweb/ },
  { name: "Netcash",        host: /(^|\.)netcash\.co\.za$/,                      token: SUB("netcash"),               module: /netcash/ },
  { name: "Payflex",        host: /(^|\.)(payflex\.co\.za|partpay\.co\.nz)$/,   token: SUB("payflex"),               module: /payflex|partpay/ },
  { name: "PayJustNow",     host: /(^|\.)payjustnow\.(com|co\.za)$/,             token: /payjustnow|pay[\s_-]just[\s_-]now/, module: /payjustnow/ },
  { name: "Mobicred",       host: /(^|\.)mobicred\.co\.za$/,                     token: SUB("mobicred"),              module: /mobicred/ },
  { name: "Happy Pay",      host: /(^|\.)happypay\.co\.za$/,                     token: /happy[\s_-]?pay/,             module: /happy_?pay/ },
  { name: "Float",          host: /(^|\.)float\.co\.za$/,                        token: null,                         module: /^float(_?payments?)?$/ },
  { name: "SnapScan",       host: /(^|\.)snapscan\.(co\.za|io)$/,               token: SUB("snapscan"),              module: /snapscan/ },
  { name: "Zapper",         host: /(^|\.)zapper\.com$/,                          token: /(^|[^a-z])zapper([^a-z]|$)/,   module: /zapper/ },
  { name: "iKhokha",        host: /(^|\.)ikhokha\.com$/,                         token: SUB("ikhokha"),               module: /ikhokha/ },
  { name: "WalletDoc",      host: /(^|\.)walletdoc\.com$/,                       token: SUB("walletdoc"),             module: /walletdoc/ },
  { name: "CallPay",        host: /(^|\.)callpay\.com$/,                         token: SUB("callpay"),               module: /callpay/ },
  { name: "iVeri",          host: /(^|\.)iveri\.(com|co\.za|net)$/,             token: null,                         module: /iveri/ },
  { name: "TradeSafe",      host: /(^|\.)tradesafe\.co\.za$/,                   token: SUB("tradesafe"),             module: /tradesafe/ },
  { name: "Stitch",         host: /(^|\.)stitch\.money$/,                        token: null,                         module: /stitch_?(money|pay)/ },
  { name: "Adumo Online",   host: /(^|\.)(adumoonline\.com|adumo\.com)$/,       token: SUB("adumo"),                 module: /adumo|virtual_?card/ },
  { name: "PayU",           host: /(^|\.)payu\.(co\.za|com|in)$/,               token: /(^|[^a-z])payu([^a-z]|$)/,     module: /^payu/ },
  { name: "PayPal",         host: /(^|\.)(paypal\.com|paypalobjects\.com)$/,    token: SUB("paypal"),                module: /paypal|ps_checkout|ppcp|ppec/ },
  { name: "Stripe",         host: /^(js|checkout|buy|m)\.stripe\.(com|network)$/, token: null,                       module: /stripe/ },
  { name: "Paystack",       host: /(^|\.)paystack\.(co|com)$/,                   token: SUB("paystack"),              module: /paystack/ },
  { name: "Flutterwave",    host: /(^|\.)(flutterwave\.com|ravepay\.co)$/,      token: SUB("flutterwave"),           module: /flutterwave|rave_?pay/ },
  { name: "Pesapal",        host: /(^|\.)pesapal\.com$/,                         token: SUB("pesapal"),               module: /pesapal/ },
  { name: "DPO",            host: /(^|\.)(3gdirectpay\.com|dpogroup\.com|directpay\.online)$/, token: null,         module: /dpo_?pay|directpay|3g_?direct/ },
  { name: "M-Pesa",         host: null,                                          token: /(^|[^a-z])m-?pesa([^a-z]|$)/,  module: /m_?pesa|lipa_?na/ },
  { name: "Paymob",         host: /(^|\.)paymob\.com$/,                          token: SUB("paymob"),                module: /paymob/ },
  { name: "Fawry",          host: /(^|\.)(fawry(pay)?\.com|atfawry\.com)$/,     token: null,                         module: /fawry/ },
  { name: "CMI",            host: /(^|\.)cmi\.co\.ma$/,                          token: null,                         module: /^cmi$|cmi_?payment/ },
  { name: "Payzone",        host: /(^|\.)payzone\.ma$/,                          token: null,                         module: /payzone/ },
  { name: "Interswitch",    host: /(^|\.)(interswitchng\.com|interswitchgroup\.com)$/, token: null,                 module: /interswitch|webpay/ },
  { name: "Klarna",         host: /(^|\.)(klarna\.com|klarnaservices\.com|klarnacdn\.net)$/, token: null,           module: /klarna/ },
  { name: "Mollie",         host: /(^|\.)mollie\.com$/,                          token: null,                         module: /mollie/ },
  // Core offline methods: a module/extension name only (a "bank transfer" badge is not evidence).
  { name: "Bank Transfer",  host: null, token: null, module: /^(bank_?transfer|bankwire|ps_wirepayment|bacs|transfer|wire|eft|manual_?eft)$/ },
  { name: "Cash on Delivery", host: null, token: null, module: /^(cod|cashondelivery|ps_cashondelivery|cash_?on_?delivery)$/ },
  { name: "Cheque",         host: null, token: null, module: /^(cheque|ps_checkpayment|check)$/ },
];

const ORDER = new Map(GATEWAYS.map((g, i) => [g.name, i]));

/** Every absolute URL's hostname in the page, from attributes and inline script strings alike. */
export function pageHosts(html) {
  const hosts = new Set();
  for (const m of html.matchAll(/(?:https?:)?\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?=[/:"'?#\s)\\]|$)/gi)) {
    hosts.add(m[1].toLowerCase().replace(/\.$/, ""));
  }
  return hosts;
}

/** Where a "we accept" badge names its gateway: image file names and alt text, and on any element
 *  the title / aria-label / class an icon-font badge carries (<a title="Paypal"><i class="icon-paypal">).
 *  Element text is deliberately not read. */
export function badgeTexts(html) {
  const out = [];
  for (const tag of html.matchAll(/<img\b[^>]*>/gi)) {
    for (const a of tag[0].matchAll(/\b(src|data-src|data-lazy-src|srcset)\s*=\s*["']([^"']{1,600})["']/gi)) {
      // A file name only: the host is covered by pageHosts, and a CDN path can carry anything.
      out.push(a[2].toLowerCase().split(/[\s,]+/).map((u) => u.split("?")[0].split("/").pop() || "").join(" "));
    }
  }
  for (const tag of html.matchAll(/<[a-z][a-z0-9-]*\s[^>]{0,12000}>/gi)) {
    for (const a of tag[0].matchAll(/\s(alt|title|aria-label|data-original-title|data-tooltip|class)\s*=\s*["']([^"'<>]{1,200})["']/gi)) {
      out.push(a[2].toLowerCase());
    }
  }
  // <svg><title>PayFast</title>…</svg> icon sprites
  for (const m of html.matchAll(/<svg\b[^>]*>\s*<title[^>]*>([^<]{1,80})<\/title>/gi)) out.push(m[1].toLowerCase());
  return out;
}

/** Payment-module names from the platform's asset paths. Generic module names (a theme, a slider)
 *  match nothing in GATEWAYS, so collecting every /modules/<x>/ is safe. */
export function paymentModules(html) {
  const h = html.toLowerCase();
  const mods = new Set();
  // PrestaShop: every hooked module serves assets from /modules/<name>/
  for (const m of h.matchAll(/\/modules\/([a-z0-9_]+)\//g)) mods.add(m[1]);
  // OpenCart 2/3: extension/payment/<code>; OpenCart 4: extension/<vendor>/…/payment/<code>, and the
  // vendor folder itself is usually the gateway (extension/payfast/catalog/…).
  for (const m of h.matchAll(/extension\/(?:[a-z0-9_]+\/)?(?:catalog\/)?(?:view\/)?(?:[a-z0-9_]+\/)*?payment\/([a-z0-9_]+)/g)) mods.add(m[1]);
  for (const m of h.matchAll(/extension\/([a-z0-9_]+)\/catalog\//g)) mods.add(m[1]);
  // Odoo: each payment provider is its own addon, payment_<provider>.
  for (const m of h.matchAll(/\/payment_([a-z0-9_]+)\/static\//g)) mods.add(m[1]);
  // WordPress plugins on non-Woo builds (SureCart, WP eCommerce, EDD…): woocommerce-gateway-payfast, payfast-…
  for (const m of h.matchAll(/wp-content\/plugins\/([a-z0-9_-]+)\//g)) mods.add(m[1].replace(/-/g, "_"));
  return mods;
}

/**
 * Gateways evidenced in one page. `ownHost` is the store's own hostname, excluded from host matching
 * (a store on *.shop.netcash.co.za would otherwise "load Netcash" from itself).
 * Returns [{ name, via: 'host'|'module'|'badge', ev }] in taxonomy order, one entry per gateway.
 */
export function detectGateways(html, ownHost = "") {
  if (!html) return [];
  const own = ownHost.toLowerCase().replace(/^www\./, "");
  const hosts = [...pageHosts(html)].filter((h) => h.replace(/^www\./, "") !== own && !h.endsWith("." + own));
  const badges = badgeTexts(html);
  const mods = [...paymentModules(html)];
  const found = new Map();
  for (const g of GATEWAYS) {
    let hit = null;
    if (g.host) { const h = hosts.find((x) => g.host.test(x)); if (h) hit = { via: "host", ev: h }; }
    if (!hit && g.module) {
      // Strip platform prefixes so "woocommerce_gateway_payfast" and "ps_payfast" test as "payfast".
      const m = mods.find((x) => g.module.test(x.replace(/^(woocommerce_gateway_|woo_|wc_|ps_(?!wirepayment|checkpayment|cashondelivery|checkout))/, "")));
      if (m) hit = { via: "module", ev: m };
    }
    if (!hit && g.token) { const b = badges.find((x) => g.token.test(x)); if (b) hit = { via: "badge", ev: b.slice(0, 60) }; }
    if (hit) found.set(g.name, { name: g.name, ...hit });
  }
  return [...found.values()].sort((a, b) => ORDER.get(a.name) - ORDER.get(b.name));
}

/** Merge several pages' findings, keeping the strongest evidence per gateway (host > module > badge). */
export function mergeFindings(...lists) {
  const rank = { host: 0, module: 1, badge: 2 };
  const m = new Map();
  for (const f of lists.flat()) {
    const cur = m.get(f.name);
    if (!cur || rank[f.via] < rank[cur.via]) m.set(f.name, f);
  }
  return [...m.values()].sort((a, b) => ORDER.get(a.name) - ORDER.get(b.name));
}

/**
 * What kind of page this is, before any gateway is read.
 *   'gone'      suspended / parked / expired / for sale: the shop is not trading (a liveness miss)
 *   'portal'    the shop sits behind a login (Odoo /shop → /web/login): a B2B trade portal, which
 *               keeps its lead but has no public checkout to read
 *   'blocked'   a bot challenge or WAF refusal: the host is up, the page can't be read
 *   'holding'   coming soon / under construction / maintenance, or HTTP auth over the whole site
 *   'ok'        a readable page
 */
export function pageState({ status = 0, url = "", text = "" } = {}) {
  const u = url.toLowerCase();
  const t = text.slice(0, 60000).toLowerCase();
  if (/\/suspended(\/|\?|$)|\/cgi-sys\/suspendedpage|\/account-?suspended/.test(u)) return "gone";
  if (/(this|the) (store|shop|account|website|site) (has been|is( currently)?|was) suspended|account suspended<|store is (currently )?(closed|unavailable|offline)/.test(t)) return "gone";
  if (/(this )?domain (name )?(is |may be )?for sale|this domain has expired|domain (has )?expired|parkingcrew|sedoparking|bodis\.com|hugedomains\.com|afternic\.com\/forsale|dan\.com\/buy-domain/.test(t)) return "gone";
  if (/\/web\/login(\?|$|#)/.test(u)) return "portal";
  if (status === 401) return "holding";                    // HTTP auth in front of the whole site
  if (status === 403 || status === 503 || status === 429) return "blocked";
  if (/just a moment\.\.\.|attention required! \| cloudflare|cf-chl-|cf_chl_opt|captcha-delivery\.com|sucuri website firewall|access denied<\/title>/.test(t)) return "blocked";
  if (/<title>[^<]{0,80}(coming soon|under construction|maintenance mode|be right back|launching soon)[^<]{0,80}<\/title>/.test(t)) return "holding";
  return "ok";
}

/** A closed hosted shop often redirects to its platform's own marketing site (heartworks.shopstar.co.za
 *  → www.shopstar.co.za, 11-25), whose footer lists every gateway the PLATFORM supports. That is a
 *  store that's gone, not a gateway answer. True when `finalUrl` is a platform home the store isn't. */
const PLATFORM_HOME = /^(www\.)?(shopstar\.co\.za|ecwid\.com|squarespace\.com|odoo\.com|wix\.com|shopify\.com|bigcommerce\.com|godaddy\.com|site123\.com|webflow\.com|weebly\.com|square\.online|squareup\.com|youcan\.shop|easy-orders\.net|lightfunnels\.com|selar\.co|getbumpa\.com|bumpa\.shop|payhip\.com|gumroad\.com|shoplazza\.com|netcash\.co\.za)$/;
export function platformHomeRedirect(domain, finalUrl) {
  let host;
  try { host = new URL(finalUrl).hostname.toLowerCase(); } catch { return false; }
  const own = String(domain).toLowerCase().replace(/^www\./, "");
  return PLATFORM_HOME.test(host) && host.replace(/^www\./, "") !== own;
}

/** One product link from a page, same site, for the product-page read (BNPL widgets and gateway
 *  badges often sit beside the price, not on the homepage). */
export function firstProductUrl(html, base) {
  let origin;
  try { origin = new URL(base); } catch { return null; }
  const re = /href\s*=\s*["']([^"'#]+)["']/gi;
  const PRODUCT = /(\/products?\/[a-z0-9][^"'?#]*|route=product\/product[^"']*product_id=\d+|\/p\/[a-z0-9][^"'?#]*|\/\d+-[a-z0-9-]+\.html|\/shop\/[a-z0-9-]+-\d+(?:[/?#]|$)|\/item\/[a-z0-9][^"'?#]*)/i;
  for (const m of html.matchAll(re)) {
    const href = m[1].replace(/&amp;/g, "&");
    if (!PRODUCT.test(href) || /\.(jpe?g|png|webp|gif|svg|css|js)(\?|$)/i.test(href)) continue;
    // Ecwid and others mount the whole shop under /products/: its utility pages aren't products.
    if (/\/products?\/(cart|account|search|checkout|login|signin|wishlist|compare|category|categories)(\/|\?|$)/i.test(href)) continue;
    try {
      const u = new URL(href, origin);
      if (u.hostname.replace(/^www\./, "") !== origin.hostname.replace(/^www\./, "")) continue;
      return u.href;
    } catch { /* bad href */ }
  }
  return null;
}

/** The second page worth reading per platform: where "we accept" badges and payment modules load. */
export const EXTRA_PATH = {
  opencart: "/index.php?route=checkout/cart",
  prestashop: "/order",
  shopstar: "/cart",
  odoo: "/shop",
  squarespace: "/cart",
  shopware: "/checkout/cart",
  bigcommerce: "/cart.php",
};
export const extraPathFor = (platform) => EXTRA_PATH[String(platform || "").toLowerCase()] ?? "/cart";

/** Platform-implied gateways: a hosted shop whose host IS the payment provider's own shop product. */
export function impliedGateways(domain) {
  if (/\.shop\.netcash\.co\.za$/i.test(domain)) return [{ name: "Netcash", via: "host", ev: "netcash shop" }];
  return [];
}

/* ---- Ecwid: the storefront's own public settings call ------------------------------------------
 * Ecwid renders checkout in JS, so no page we fetch names a gateway. But every Ecwid storefront, on
 * load, POSTs {"lang":"en"} to app.ecwid.com/storefront/api/v1/<storeId>/initial-data (no token, no
 * cart, no customer details) and gets back storeProfile.value.jsApiOnly.paymentMethods: the methods
 * the merchant has switched on, each with its processor ("payFast", "offline", a payment app's
 * namespace). Found 2026-11-26 by watching what a browser loads; plain HTTP returns the same JSON.
 */

/** The Ecwid store id a page embeds, or null. */
export function ecwidStoreId(html, domain = "") {
  const m = /\bstore(\d{5,10})\.shop\.netcash\.co\.za$/i.exec(domain);
  if (m) return m[1];
  if (!/ecwid/i.test(html)) return null;
  for (const re of [
    /app\.ecwid\.com\/script\.js\?(\d{5,10})/,
    /storefront\/api\/v1\/(\d{5,10})\//,
    // storeId / siteId / ownerid, also inside escaped JSON (\"siteId\":78879008 on Instant Sites)
    /\\?["']?(?:storeId|siteId)\\?["']?\s*[:=]\s*\\?["']?(\d{5,10})\b/i,
    /[?&]ownerid=(\d{5,10})\b/i,
    /\/images\/(\d{5,10})\/\d+/,                 // Ecwid's image CDN path: /images/<storeId>/<imageId>…
  ]) { const x = re.exec(html); if (x) return x[1]; }
  return null;
}

/** Same registrable host, ignoring www (so a store id lifted from a page belongs to that store). */
const sameSite = (a, b) => String(a || "").toLowerCase().replace(/^www\./, "") === String(b || "").toLowerCase().replace(/^www\./, "");

/**
 * Read Ecwid's initial-data JSON.
 * Returns { ok, closed, storeHost, gateways:[canonical names], methods:[raw {name, processor, app}] }.
 * `ok` is false when the payload isn't an Ecwid store profile.
 */
export function ecwidPayments(json) {
  const v = json?.storeProfile?.value;
  // A closed store answers 409 with storeProfile {type: "general-closed"} and no value.
  if (!v && json?.storeProfile?.type && json.storeProfile.type !== "opened") return { ok: true, closed: true, storeHost: null, gateways: [], methods: [] };
  if (!v) return { ok: false, closed: false, storeHost: null, gateways: [], methods: [] };
  const closed = json.storeProfile.type && json.storeProfile.type !== "opened" || v.store?.closed === true || v.flags?.isStoreClosed === true;
  let storeHost = null;
  try { storeHost = new URL(v.jsApiOnly?.storeUrl || "").hostname.toLowerCase(); } catch { /* none */ }
  const methods = (v.jsApiOnly?.paymentMethods || []).map((m) => ({
    name: String(m.name || ""), processor: String(m.processor || ""), app: String(m.appNamespace || m.appClientId || ""),
  }));
  const out = [];
  const add = (n) => { if (n && !out.includes(n)) out.push(n); };
  for (const m of methods) {
    const key = (m.processor === "customPaymentApp" ? m.app : m.processor).toLowerCase().replace(/[\s-]+/g, "_");
    const name = m.name.toLowerCase();
    if (m.processor === "offline" || !key) {
      // A merchant-named manual method: "Pay by EFT", "Cash on delivery", "SnapScan on collection"…
      const named = GATEWAYS.find((g) => g.token && g.token.test(name));
      if (named) add(named.name);
      else if (/\beft\b|bank|transfer|deposit|wire/.test(name)) add("Bank Transfer");
      else if (/cash|\bcod\b|on delivery|on collection/.test(name)) add("Cash on Delivery");
      continue;
    }
    const g = GATEWAYS.find((x) => x.module && x.module.test(key));
    if (g) add(g.name);
    else if (/^paypal/.test(key)) add("PayPal");
    else if (/^stripe/.test(key)) add("Stripe");
  }
  return { ok: true, closed: !!closed, storeHost, gateways: out.sort((a, b) => ORDER.get(a) - ORDER.get(b)), methods };
}

/** True when the store profile's own URL is this domain (or an Ecwid/Netcash-hosted one we can't
 *  compare): guards against a page that embeds SOMEONE ELSE's Ecwid store id. */
export function ecwidOwns(storeHost, domain) {
  if (!storeHost) return true;
  if (/(^|\.)(company\.site|ecwid\.com|shop\.netcash\.co\.za)$/.test(storeHost)) return true;
  return sameSite(storeHost, domain) || storeHost.endsWith("." + String(domain).replace(/^www\./, ""));
}
