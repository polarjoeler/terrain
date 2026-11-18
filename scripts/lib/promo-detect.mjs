/**
 * promo-detect — pure helpers for promo-scan.mjs: turn a store's homepage HTML, Klaviyo form text
 * and collection sitemap into structured promo offers. No I/O here, so it can be unit-tested
 * (scripts/lib/promo-detect.test.mjs).
 *
 * An offer's `kind`:
 *   bf      — names Black Friday / Cyber Monday / Black November etc. Always eligible for the BF page.
 *   welcome — a sign-up / first-order discount with no BF wording. The ~10% of ZA stores that run
 *             one all year (popup test 2026-11-18) — never shown as a BF deal.
 *   sale    — a generic "% off" with neither. Eligible only if it was NOT already there in the
 *             pre-BF baseline scan (store_promos.seen_in_baseline).
 */

export const BF_RE = /black[\s-]*friday|cyber[\s-]*monday|black[\s-]*november|black[\s-]*week(?:end)?|cyber[\s-]*week|\bbfcm\b/i;
const BF_RE_G = new RegExp(BF_RE.source, "gi");
// "%" offers: "30% off", "up to 50 % discount", "save 20%", "extra 15%".
const PCT_RE_G = /(?:(up\s*to|save|extra|get|enjoy)\s*)?(\d{1,2})\s?%(?:\s*(off|discount|sale|savings?|korting))?/gi;
const RAND_RE = /\bR\s?(\d{2,5})(?:[.,]00)?\s*(?:off|discount)/i;
const SITEWIDE_RE = /site[\s-]?wide|store[\s-]?wide|everything|all products|entire (?:store|site|range)/i;
const WELCOME_RE = /first (?:order|purchase|online order)|sign[\s-]?up|subscrib|newsletter|join (?:our|the)|welcome|when you join|email list|vip list/i;
const CODE_RE = /\b(?:code|coupon|promo)\s*[:\-]?\s*["“'‘]?([A-Z][A-Z0-9]{3,14})\b/;
// Handles / paths that are a BF landing page: /collections/black-friday, /product-category/bf-sale/…
export const BF_LINK_RE = /black-?friday|cyber-?monday|black-?november|\bbfcm\b|bf-?sale|bf-?20\d\d|black-?week/i;

const ENTITIES = { amp: "&", nbsp: " ", quot: '"', apos: "'", lt: "<", gt: ">", rsquo: "'", lsquo: "'", ndash: "-", mdash: "-", hellip: "…" };
export function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => { const c = Number(n); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : " "; })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { const c = parseInt(h, 16); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : " "; })
    .replace(/&([a-z]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m);
}

/** Visible-ish text of an HTML page: drops script/style/svg/noscript/template, tags, entities. */
export function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|svg|noscript|template|iframe)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|section|header|a|span|button)>/gi, " · ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .replace(/(?:\s·\s?){2,}/g, " · ")
    .trim();
}

export const findKlaviyoCid = (html) =>
  html.match(/(?:company_id|klaviyo\.js\?company_id|"company_id")[=:"\s]*([A-Za-z0-9]{6})\b/)?.[1] ?? null;

/** Same-site links on the page whose path names a BF landing page. */
export function bfLinksFromHtml(html, pageUrl) {
  const out = new Map();
  let base;
  try { base = new URL(pageUrl); } catch { return []; }
  for (const m of html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
    let u;
    try { u = new URL(decodeEntities(m[1]), base); } catch { continue; }
    if (u.hostname.replace(/^www\./, "") !== base.hostname.replace(/^www\./, "")) continue;
    if (!BF_LINK_RE.test(u.pathname)) continue;
    out.set(u.pathname, `${u.origin}${u.pathname}`);
  }
  return [...out.values()].slice(0, 5);
}

/** BF collection URLs from a Shopify sitemap_collections_N.xml. */
export function bfLinksFromSitemap(xml) {
  const out = [];
  for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const loc = decodeEntities(m[1]).trim();
    let path;
    try { path = new URL(loc).pathname; } catch { continue; }
    if (/\/collections\//.test(path) && BF_LINK_RE.test(path)) out.push(loc);
  }
  return out.slice(0, 5);
}

/** The collections sub-sitemap(s) listed in a Shopify /sitemap.xml index. */
export const collectionSitemaps = (xml) =>
  [...xml.matchAll(/<loc>([^<]*sitemap_collections[^<]*)<\/loc>/g)].map((m) => decodeEntities(m[1]).trim());

/** Pull readable strings out of a Klaviyo form's `views` JSON (text lives under views, not data). */
export function klaviyoText(views) {
  const strs = [];
  (function walk(x, k) {
    if (typeof x === "string") {
      if (!/html|content|text|label|title|headline|body/i.test(k || "")) return;
      const t = htmlToText(x);
      if (t.length > 2) strs.push(t);
    } else if (x && typeof x === "object") for (const kk in x) walk(x[kk], kk);
  })(views);
  return strs.join(" · ");
}

const isOfferSeg = (s) => {
  if (BF_RE.test(s)) return true;
  for (const m of s.matchAll(PCT_RE_G)) if ((m[1] || m[3]) && Number(m[2]) >= 5 && Number(m[2]) <= 90) return true;
  return RAND_RE.test(s);
};
const clip = (s, n) => (s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, "") + "…");

/** Parse one snippet into offer fields. */
export function parseOffer(snippet) {
  let pct = null, upTo = false;
  for (const m of snippet.matchAll(PCT_RE_G)) {
    // A bare "20%" only counts when it sits next to an offer word; "100% cotton" etc. never does.
    if (!m[1] && !m[3]) continue;
    const n = Number(m[2]);
    if (n < 5 || n > 90) continue;
    if (pct === null || n > pct) { pct = n; upTo = /up\s*to/i.test(m[1] || ""); }
  }
  const rand = snippet.match(RAND_RE);
  const bf = BF_RE.test(snippet);
  const welcome = !bf && WELCOME_RE.test(snippet);
  return {
    kind: bf ? "bf" : welcome ? "welcome" : "sale",
    pct_max: pct,
    up_to: upTo,
    sitewide: SITEWIDE_RE.test(snippet),
    rand_off: rand ? Number(rand[1]) : null,
    code: snippet.match(CODE_RE)?.[1] ?? null,
  };
}

/**
 * Offers in a block of text. One snippet per BF mention or %-off mention, overlapping windows
 * merged. A BF mention with no number is still an offer ("Black Friday sale now on") — the page
 * shows it as "Sale on" rather than a %.
 */
export function detectOffers(text, { maxOffers = 4 } = {}) {
  if (!text) return [];
  // Work in page segments (htmlToText puts " · " between block elements), so a snippet is the
  // banner line itself plus its immediate neighbours — not 300 characters of nav menu.
  const segs = text.split(/\s*·\s*/).map((s) => s.trim()).filter(Boolean);
  const runs = [];
  segs.forEach((s, i) => {
    if (!isOfferSeg(s)) return;
    const last = runs[runs.length - 1];
    if (last && i - last.end <= 2) last.end = i;
    else runs.push({ start: i, end: i });
  });
  const offers = [];
  const seen = new Set();
  for (const { start, end } of runs) {
    const core = segs.slice(start, end + 1).slice(0, 4);
    // Short neighbours ride along ("Black Friday · Up to 50% · Selected styles"); long ones are
    // product cards or nav dumps.
    const before = start > 0 && segs[start - 1].length <= 60 ? [segs[start - 1]] : [];
    const after = segs[end + 1] && segs[end + 1].length <= 60 ? [segs[end + 1]] : [];
    const snippet = clip([...before, ...core.map((s) => clip(s, 140)), ...after].join(" · "), 280);
    const o = parseOffer(snippet);
    if (o.kind !== "bf" && o.pct_max === null && o.rand_off === null) continue;
    const key = `${o.kind}:${o.pct_max ?? ""}:${o.rand_off ?? ""}:${o.sitewide ? 1 : 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    offers.push({ ...o, offer_text: snippet, key });
  }
  // BF first, then the deepest discount.
  offers.sort((x, y) => (y.kind === "bf") - (x.kind === "bf") || (y.pct_max ?? 0) - (x.pct_max ?? 0));
  return offers.slice(0, maxOffers);
}
