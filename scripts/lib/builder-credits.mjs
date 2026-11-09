/** builder-credits — the shared builder-attribution DETECTOR.
 *
 *  One source of truth for "does this store's HTML credit the agency/developer that built it, and to
 *  whom?", used by both `scripts/attribute-partners.mjs` (production attribution) and
 *  `scripts/credit-incidence.mjs` (the measurement pass). Pure: no I/O, no DB — give it the page HTML
 *  and the known-partner identity maps, it returns which signals fired, the edges to known partners,
 *  and the unknown linked credits to bank as candidates.
 *
 *  Signals (each with its own source/confidence; only strong ones are published):
 *    footer linked credit  footer/public_credit   [published]   — "designed by <a>X</a>"
 *    footer text credit    footer/text_credit                   — "designed by X" (name→known partner)
 *    html comment credit   comment/comment_credit               — "<!-- Built by X -->"
 *    meta generator        generator/generator_meta             — <meta name=generator content=X>
 *    theme author/credit   theme/theme_author                   — "theme by X"
 *  A credit is only counted when the credited NAME/HOST is not a platform/CMS/theme/app — "Powered by
 *  Shopify" is a platform badge, not a builder credit.
 */

export const hostOf = (u) => {
  try { return new URL(u.includes("://") ? u : `https://${u}`).hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return null; }
};

// Credit verbs shared across signals: site/web/store/website/built/designed/developed/created/
// made/crafted/powered by.
const VERBS = "site|web|store|website|built|designed|developed|created|made|crafted|powered";
const CREDIT_LINKED = new RegExp(`(?:${VERBS})\\s+by\\s*:?\\s*<a[^>]+href=["']([^"']+)["'][^>]*>([^<]{2,60})</a>`, "gi");
const CREDIT_TEXT = new RegExp(`(?:${VERBS})\\s+by\\s*:?\\s*([A-Za-z0-9][A-Za-z0-9&.\\-' ]{2,40})`, "g");
const META_GEN = /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']{2,80})["']/i;
const THEME_CREDIT = /theme\s+(?:by|author|credits?)\s*:?\s*(?:<a[^>]+href=["']([^"']+)["'][^>]*>)?\s*([A-Za-z0-9&.\-' ]{2,40})/i;
const COMMENT_CREDIT = new RegExp(`(?:${VERBS}|design|development)\\s+by\\s*:?\\s*([A-Za-z0-9&.\\-' ]{2,50})`, "i");
const COMMENT_URL = /(https?:\/\/[^\s"'<>]+)/i;

// A captured credit name can trail into a URL or a separator ("OrderEazi https…", "Pixel Fusion |").
export const cleanName = (s) => (s || "")
  .replace(/\s+(?:https?\b|www\.).*$/i, "")
  .replace(/^["'\s|·—–\-]+|["'\s|·—–\-]+$/g, "")
  .replace(/\s+/g, " ")
  .trim();

// Platform / CMS / theme / builder names that are NOT agencies — never an edge, never a candidate.
const PLATFORM_NOISE = new Set([
  "shopify", "wordpress", "woocommerce", "wix", "squarespace", "webflow", "elementor", "wp bakery",
  "wpbakery", "divi", "gutenberg", "drupal", "joomla", "bigcommerce", "prestashop", "magento", "opencart",
  "hugo", "gatsby", "next.js", "nextjs", "react", "html", "html5", "blogger", "ghost", "framer", "bubble",
  "shopstar", "bumpa", "selar", "catlog", "google", "cloudflare", "godaddy", "hubspot", "yoast seo",
  "yoast", "shogun", "pagefly", "gempages", "dawn", "debut", "brooklyn", "impulse", "prestige", "turbo",
  "flex", "motion", "warehouse", "the team", "us", "me", "admin", "support", "team",
]);
export const platformNoise = (name) => {
  const n = (name || "").toLowerCase().trim();
  if (!n || n.length < 3) return true;
  if (PLATFORM_NOISE.has(n)) return true;
  if (/\btheme(s)?\b/.test(n)) return true;
  return /^(shopify|wordpress|woocommerce|wix|squarespace|webflow|elementor|drupal|joomla|magento|prestashop|bigcommerce|ghost|hugo|gatsby|framer)\b/.test(n);
};
export const platformHost = (h) => h && /shopify|wix|squarespace|wordpress|woocommerce|godaddy|cloudflare|webflow|bigcommerce|prestashop|magento|framer|myshopify|wpastra|elegantthemes|outofthesandbox|outtheboxthemes|halothemes|themefreesia|bizbergthemes|cosmoswp|risethemes|rstheme|cleanthemes|svgrepo|smartsupp|spurpopups|shogun|pagefly/.test(h);

/**
 * Detect builder credits on one store's HTML.
 * @param {string} html  full page HTML
 * @param {{byName?: Map<string,string>, byHost?: Map<string,string>}} maps  known-partner identity maps
 * @returns {{
 *   credited: boolean,                 // ANY non-platform builder credit fired
 *   signals: Set<string>,              // which signal types fired (public_credit|text_credit|comment_credit|generator_meta|theme_author)
 *   matched: Array<{partner_id, store, source, confidence, published, evidence, name}>,  // edges to known partners
 *   candidates: Array<{name, host, example_store}>,                                      // unknown linked credits to bank
 * }}
 */
export function detectCredits(html, { byName = new Map(), byHost = new Map(), store = "" } = {}) {
  const head = html.slice(0, 80_000);
  const tail = html.slice(-120_000);
  const matchPartner = (name, h) => (h && byHost.get(h)) || (name && byName.get(name.toLowerCase().trim())) || null;

  const signals = new Set();
  const matched = [];
  const candidates = [];

  // (a) footer linked credits — strongest on-page signal.
  for (const m of tail.matchAll(CREDIT_LINKED)) {
    const chost = hostOf(m[1]); const cname = cleanName(m[2]);
    if (platformNoise(cname) || platformHost(chost)) continue;
    signals.add("public_credit");
    const pid = matchPartner(cname, chost);
    if (pid) matched.push({ partner_id: pid, store, source: "footer", confidence: "public_credit", published: true, evidence: `credited "${cname}"`, name: cname });
    else if (chost) candidates.push({ name: cname, host: chost, example_store: store });
  }
  // (b) footer text-only credits — match a KNOWN partner by name only (no banking).
  for (const m of tail.matchAll(CREDIT_TEXT)) {
    const cname = cleanName(m[1]);
    if (platformNoise(cname)) continue;
    const pid = byName.get(cname.toLowerCase());
    if (pid) { signals.add("text_credit"); matched.push({ partner_id: pid, store, source: "footer", confidence: "text_credit", published: false, evidence: `text credit "${cname}"`, name: cname }); }
  }
  // (c) HTML comments crediting an agency.
  for (const cm of html.matchAll(/<!--([\s\S]{0,400}?)-->/g)) {
    const body = cm[1];
    const mm = COMMENT_CREDIT.exec(body);
    if (!mm) continue;
    const cname = cleanName(mm[1]);
    if (platformNoise(cname)) continue;
    const uhost = hostOf((COMMENT_URL.exec(body) || [])[1] || "");
    if (platformHost(uhost)) continue;
    signals.add("comment_credit");
    const pid = matchPartner(cname, uhost);
    if (pid) matched.push({ partner_id: pid, store, source: "comment", confidence: "comment_credit", published: false, evidence: `html comment "${cname}"`, name: cname });
    else if (uhost) candidates.push({ name: cname, host: uhost, example_store: store });
  }
  // (d) <meta name="generator"> naming a non-platform entity.
  const gm = META_GEN.exec(head);
  if (gm) {
    const gname = cleanName(gm[1]);
    if (!platformNoise(gname)) {
      signals.add("generator_meta");
      const pid = byName.get(gname.toLowerCase());
      if (pid) matched.push({ partner_id: pid, store, source: "generator", confidence: "generator_meta", published: false, evidence: `meta generator "${gname}"`, name: gname });
    }
  }
  // (e) theme author/credit.
  const tm = THEME_CREDIT.exec(head) || THEME_CREDIT.exec(tail);
  if (tm) {
    const thost = hostOf(tm[1] || ""); const tname = cleanName(tm[2] || "");
    if (!platformNoise(tname) && !platformHost(thost)) {
      signals.add("theme_author");
      const pid = matchPartner(tname, thost);
      if (pid) matched.push({ partner_id: pid, store, source: "theme", confidence: "theme_author", published: false, evidence: `theme credit "${tname}"`, name: tname });
      else if (thost) candidates.push({ name: tname, host: thost, example_store: store });
    }
  }

  return { credited: signals.size > 0, signals, matched, candidates };
}
