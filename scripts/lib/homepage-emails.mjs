/**
 * homepage-emails — every address a store publishes on its own homepage, best first.
 *
 * ai-enrich used to take the first own-domain address and nothing else. Measured on 2026-11-18
 * (60 random AI-enriched ZA/KE/NG stores with no email, 38 reachable through the fleet), 6 had a
 * usable address on the very page we had already read:
 *   - 4 were the merchant's Gmail/Outlook (atenzahomeappliances@gmail.com on
 *     atenzahomeappliances.co.za). The own-domain rule rejected them. In our markets the owner's
 *     Gmail IS the shop's address, and it is the commonest pattern in KE/NG.
 *   - 2 were own-domain addresses the direct fetch never saw (blocked or throttled).
 *
 * Freemail on a homepage is the risky case. Theme markup and footers carry other people's
 * addresses (developer credits, the theme vendor, a marketplace seller), which is why
 * contact-enrich only trusts freemail found on a contact/about page. Here it is accepted only when
 * the mailbox name resembles the store's own brand (luxeglow16@gmail.com on luxeglow.co.za).
 * A stranger's Gmail doesn't match the brand, so it stays out.
 *
 * Also read: Cloudflare's email obfuscation (data-cfemail / /cdn-cgi/l/email-protection#…, common
 * on WordPress/Woo behind Cloudflare), HTML-entity-encoded @ (&#64; / &#x40;), and JSON-LD "email".
 */

export const FREEMAIL = /@(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|aol|protonmail|proton|zoho|mail|gmx|webmail|telkomsa|vodamail|mweb|iafrica|absamail|yebo|naver|docomo|ezweb|au\.com|softbank|yahoo\.co\.jp)\./i;

const EMAIL_JUNK = /(sentry|wixpress|example\.|godaddy|shopify\.com|myshopify|fakedomain|yourdomain|your@|youremail|email@example|no-?reply|donotreply|do-not-reply|placeholder|test@|sample@|domain\.com|cloudflare|wordpress\.|squarespace|bigcommerce|mailchimp|klaviyo|gorgias|zendesk|intercom|u002f|%40)/i;
const PLACEHOLDER_LOCAL = new Set(["example", "examples", "name", "yourname", "your-name", "firstname",
  "lastname", "fullname", "user", "username", "someone", "demo", "dummy", "test", "testing", "abc",
  "xyz", "myemail", "mymail", "myname", "address", "emailaddress", "changeme", "info-example", "email", "mail"]);
const TLDISH = new Set(["com", "net", "org", "co", "za", "ke", "ng", "jp", "io", "biz", "info",
  "africa", "myshopify", "site", "app", "dev", "web", "www", "shop", "store", "online"]);
// Generic shop words: "shop" in shopgirl@gmail.com and shopnow.co.za is not a brand match.
const WEAK = new Set(["shop", "store", "online", "the", "and", "official", "africa", "sa", "za", "ng", "ke",
  "mall", "market", "buy", "sales", "info", "hello", "home", "best", "new", "global", "world"]);

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/g;

const emailHost = (e) => { const m = /@([a-z0-9.-]+\.[a-z]{2,})/i.exec(e || ""); return m ? m[1].toLowerCase() : null; };
export const sameOrg = (host, storeDomain) => {
  if (!host || !storeDomain) return false;
  const sd = String(storeDomain).toLowerCase().replace(/^www\./, "");
  return host === sd || host.endsWith("." + sd) || sd.endsWith("." + host);
};

/** Cloudflare Email Address Obfuscation: hex string, first byte is the XOR key. */
export function decodeCfEmail(hex) {
  if (!/^[0-9a-f]{4,}$/i.test(hex || "") || hex.length % 2) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return /^[^@\s]+@[^@\s]+\.[a-z]{2,24}$/i.test(out) ? out : null;
}

/** The store's brand as letters only, from every meaningful domain label: "luxe-glow.co.za" → ["luxeglow", "luxe", "glow"]. */
function brandStems(domain) {
  const out = new Set();
  for (const label of String(domain).toLowerCase().replace(/^www\./, "").split(".")) {
    if (label.length < 3 || TLDISH.has(label)) continue;
    const flat = label.replace(/[^a-z]/g, "");
    if (flat.length >= 4) out.add(flat);
    for (const p of label.split(/[-_]/)) { const q = p.replace(/[^a-z]/g, ""); if (q.length >= 4 && !WEAK.has(q)) out.add(q); }
  }
  return [...out];
}

/** A freemail mailbox that names the store: the mailbox contains the brand, or the brand contains the mailbox. */
export function brandMatches(local, domain) {
  const l = String(local).toLowerCase().replace(/[^a-z]/g, "");
  if (l.length < 4) return false;
  for (const b of brandStems(domain)) {
    if (WEAK.has(b)) continue;
    // luxeglow16@ on luxeglow.co.za, eyaneafrica@ on eyane.co.za. Containment only: a looser
    // shared-letters rule matched strangers (beautyqueen@ on glowbeauty.co.za).
    if (l.includes(b) || (b.includes(l) && l.length >= 5)) return true;
  }
  return false;
}

/**
 * @returns {{email:string, kind:'own'|'freemail', how:'mailto'|'text'|'jsonld'|'cfemail'}[]} best first:
 *          own-domain before freemail, then mailto/JSON-LD before body text, then document order.
 */
export function homepageEmails(html, domain) {
  if (!html) return [];
  const found = new Map();
  const push = (raw, how) => {
    let e = String(raw || "").trim().toLowerCase().replace(/^mailto:/, "").replace(/[.,;:)\]}'"]+$/, "");
    try { e = decodeURIComponent(e); } catch { /* keep raw */ }
    if (found.has(e) || !/^[^@\s]+@[^@\s]+\.[a-z]{2,24}$/.test(e)) return;
    if (EMAIL_JUNK.test(e) || /\.(png|jpe?g|gif|svg|webp|css|js)$/.test(e)) return;
    const local = e.split("@")[0];
    if (PLACEHOLDER_LOCAL.has(local.replace(/[^a-z-]/g, "")) || /u00[0-9a-f]{2}/i.test(local)) return;
    const own = sameOrg(emailHost(e), domain);
    const free = !own && FREEMAIL.test(e) && brandMatches(local, domain);
    if (!own && !free) return;
    found.set(e, { email: e, kind: own ? "own" : "freemail", how });
  };
  // Entity-encoded @ and dots in body copy: info&#64;shop.co.za
  const text = html.replace(/&#0*64;|&#x0*40;|&commat;/gi, "@").replace(/&#0*46;|&#x0*2e;|&period;/gi, ".");
  for (const m of text.matchAll(/data-cfemail=["']([0-9a-f]+)["']/gi)) push(decodeCfEmail(m[1]), "cfemail");
  for (const m of text.matchAll(/email-protection#([0-9a-f]+)/gi)) push(decodeCfEmail(m[1]), "cfemail");
  for (const m of text.matchAll(/"email"\s*:\s*"([^"]+)"/gi)) push(m[1], "jsonld");
  for (const m of text.matchAll(/mailto:([^"'?&<>\s]+)/gi)) push(m[1], "mailto");
  for (const m of text.matchAll(EMAIL_RE)) push(m[0], "text");
  const howRank = { mailto: 0, jsonld: 0, cfemail: 1, text: 2 };
  return [...found.values()].map((v, i) => ({ ...v, i }))
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "own" ? -1 : 1) || howRank[a.how] - howRank[b.how] || a.i - b.i)
    .map(({ i, ...v }) => v);
}

export const bestHomepageEmail = (html, domain) => homepageEmails(html, domain)[0]?.email ?? null;
