/** confirm-custom — the publish path for banked 'custom' stores (bespoke / headless builds).
 *
 *  platform='custom' means no detector recognised the stack (Next.js/Nuxt/Laravel/Angular builds,
 *  plus anything we don't fingerprint yet). 2026-11-19: 12,092 such rows, 12 published — no lane ever
 *  published one, so Konga, Slot, MedPlus, Fouani and the other big bespoke African retailers stayed
 *  invisible. They are mixed in with betting, news, fintech checkouts and SaaS (the crux-ranked lane
 *  lands every CrUX-ranked origin), so the bar here is HIGHER than confirm-other-cms, where the
 *  platform itself is evidence of a store. A row is published only when its OWN homepage shows ALL of:
 *
 *    1. it is the site itself — 200 HTML on the same host (a redirect to another domain is skipped:
 *       watchstore.com.ng now redirects to a betting site),
 *    2. a real commerce action — confirm-other-cms's strict ECOM test (add-to-cart / cart / checkout
 *       link / product price markup),
 *    3. prices in the row's OWN market currency — two or more "₦12,500"-style prices, or schema.org
 *       priceCurrency equal to that currency. This is also the country evidence: crux-ranked stamps the
 *       CrUX market as the country, which is wrong for global sites (figma.com "NG"); a page priced in
 *       naira is selling in Nigeria. country_source becomes 'storefront' (manual is never touched),
 *    4. a name and description that don't say betting / news / loans / hosting / SMS / airline / school…
 *       (the non-retail classes that carry ₦ prices and a "checkout" too),
 *    5. a real name (confirm-other-cms's extractName/badName).
 *
 *  A Bagisto storefront (/vendor/webkul/ assets) is relabelled Bagisto on the way through.
 *  Every attempt stamps cms_confirm_at, so failures wait 7 days (unreachable) / 30 days (live, not
 *  publishable) before a retry. Different host per row, low concurrency, a pause between fetches.
 *
 *    node --env-file=.env.local scripts/confirm-custom.mjs --dry [--country NG,KE] [--limit 300]
 *    node --env-file=.env.local scripts/confirm-custom.mjs [--limit 1500] [--concurrency 4]
 */
import postgres from "postgres";
import { ECOM, decodeHtml, extractName, badName } from "./confirm-other-cms.mjs";

const DRY = process.argv.includes("--dry");
const VERBOSE = process.argv.includes("--verbose");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const LIMIT = Number(arg("--limit", 1500));
const CONC = Number(arg("--concurrency", 4));
const PAUSE_MS = Number(arg("--pause", 800));
const cArg = arg("--country", null);

// Verbatim from lib/markets.ts VISIBLE_MARKETS — only rows a customer could see are worth publishing.
const VISIBLE_MARKETS = [
  "ZA", "KE", "NG", "EG", "MA", "GH", "TZ", "UG", "DZ", "TN", "CI", "SN", "MU", "MZ",
  "CM", "BW", "AO", "NA", "RW", "ZM", "ET", "ZW", "LY", "MW", "SO", "LS", "SZ",
];
const countries = cArg ? cArg.split(",").map((c) => c.trim().toUpperCase()).filter((c) => VISIBLE_MARKETS.includes(c)) : VISIBLE_MARKETS;

// Market currency: ISO code + the symbols shops actually print. Single-letter symbols (R, P, K, M, E)
// only count with a formatted amount ("R 1,299" / "P120.00"), never a bare letter + digit.
const CCY = {
  ZA: ["ZAR", String.raw`R\s?\d{1,3}(?:[ ,]\d{3})*(?:[.,]\d{2})?\b`],
  NG: ["NGN", "₦", "&#8358;", "&#x20a6;"],
  KE: ["KES", "KSh", "Ksh", "KShs"],
  EG: ["EGP", "ج\\.م", "جنيه", String.raw`\bLE\s?\d`],
  MA: ["MAD", String.raw`\bDH\b`, String.raw`\bDhs?\b`, "درهم"],
  GH: ["GHS", "GH₵", "GH¢", "₵"],
  TZ: ["TZS", "TSh", "Tsh"],
  UG: ["UGX", "USh", "Ush"],
  DZ: ["DZD", String.raw`\bDA\b`, "دج"],
  TN: ["TND", String.raw`\bDT\b`, "د\\.ت"],
  CI: ["XOF", "FCFA", "CFA"], SN: ["XOF", "FCFA", "CFA"], CM: ["XAF", "FCFA", "CFA"],
  MU: ["MUR", String.raw`\bRs\.?\s?\d`],
  MZ: ["MZN", String.raw`\bMT\b`, "MTn"],
  BW: ["BWP", String.raw`\bP\s?\d{1,3}(?:,\d{3})*\.\d{2}\b`],
  AO: ["AOA", "Kz"],
  NA: ["NAD", "N\\$"],
  RW: ["RWF", "FRw", String.raw`\bRF\b`],
  ZM: ["ZMW", String.raw`\bK\s?\d{1,3}(?:,\d{3})*\.\d{2}\b`],
  ET: ["ETB", String.raw`\bBirr\b`, "ብር"],
  ZW: ["ZWL", "ZiG", "USD", "US\\$"],          // Zimbabwe retail prices largely in USD
  LY: ["LYD", "د\\.ل"],
  MW: ["MWK", String.raw`\bMK\s?\d`],
  SO: ["SOS", "USD", "US\\$"],
  LS: ["LSL", "ZAR", String.raw`\bM\s?\d{1,3}(?:,\d{3})*\.\d{2}\b`, String.raw`R\s?\d{1,3}(?:[ ,]\d{3})*\.\d{2}\b`],
  SZ: ["SZL", "ZAR", String.raw`\bE\s?\d{1,3}(?:,\d{3})*\.\d{2}\b`, String.raw`R\s?\d{1,3}(?:[ ,]\d{3})*\.\d{2}\b`],
};
const AMOUNT = String.raw`\d{1,3}(?:[ ,.]\d{3})*(?:[.,]\d{1,2})?`;
// "₦12,500" / "12,500 KES" / "KSh 1,299.00". Patterns that already include an amount stand alone.
export function priceRe(cc) {
  const parts = (CCY[cc] || []).map((s) => (/\\d/.test(s) ? s : `(?:${s})\\s?${AMOUNT}|${AMOUNT}\\s?(?:${s})(?![A-Za-z])`));
  return parts.length ? new RegExp(parts.join("|"), "g") : null;
}
const ISO = Object.fromEntries(Object.entries(CCY).map(([cc, v]) => [cc, v.filter((s) => /^[A-Z]{3}$/.test(s))]));
export function localPrices(html, cc) {
  const ld = [...html.matchAll(/"priceCurrency"\s*:\s*"([A-Z]{3})"/g)].map((m) => m[1]);
  if (ld.some((c) => (ISO[cc] || []).includes(c))) return 99;      // structured data says so — decisive
  const re = priceRe(cc);
  if (!re) return 0;
  const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ");
  return (body.match(re) || []).length;
}

// Non-retail classes that still carry local prices and a "checkout": the crux-ranked custom bucket is
// full of them (betking.com, opayweb.com, flyvaluejet.com, whogohost.com, accsmarket.com, …).
const NOT_RETAIL = new RegExp(String.raw`\b(?:bet|bets|betting|casino|sportsbook|jackpot|lotto|lottery|poker|livescores?|live scores?|fixtures|` +
  String.raw`forex|crypto|bitcoin|trading|prop firm|loans?|lending|microfinance|bank|banking|insurance|pension|fund managers|` +
  String.raw`news|newspapers?|blog|magazine|hosting|domain names?|vpn|sms|otp|virtual numbers?|esims?|social media (?:accounts|boost)|` +
  String.raw`smm panel|logs|data bundles?|vtu|bills? payment|airlines?|flights?|bus tickets?|transport company|` +
  String.raw`school|university|academy|courses?|e-?learning|tutors?|past questions|exam|jobs?|recruitment|church|ministry|` +
  String.raw`foundation|government|movies?|streaming|download|novels?|lyrics|hymns|dating|hookup|escort|adult|` +
  String.raw`credit bureau|credit reports?|tickets?|events? platform|price comparison|compare prices)\b`, "i");
export function looksNonRetail(html) {
  const title = html.match(/<title[^>]*>([^<]{0,300})/i)?.[1] || "";
  const desc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{0,400})/i)?.[1] || "";
  const site = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']{0,120})/i)?.[1] || "";
  return (`${title} ${desc} ${site}`.match(NOT_RETAIL) || [])[0] || null;
}
const BAGISTO = /\/vendor\/webkul\/|bagisto/i;

const NON_PROD_HOST = String.raw`^(dev|stg|stage|staging|test|uat|qa|preview|sandbox|api|admin|cms|pay|checkout|portal|app|dashboard|client|login|account|accounts|backend|sdk|mail|webmail)[-.]|[-.](stg|staging|dev|uat|sandbox)[-.]|myshopify\.com$`;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const bare = (h) => (h || "").toLowerCase().replace(/^www\./, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHome(domain, ms = 12000) {
  try {
    const r = await fetch(`https://${domain}/`, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(ms) });
    if (!r.ok) return { fail: `http_${r.status}` };
    if (bare(new URL(r.url).host) !== bare(domain)) return { fail: "redirect_offsite", to: new URL(r.url).host };
    const ct = r.headers.get("content-type") || "";
    if (!/html/i.test(ct)) return { fail: "not_html" };
    return { html: decodeHtml(await r.arrayBuffer(), ct).slice(0, 1_200_000) };
  } catch { return { fail: "unreachable" }; }
}

/** The publish decision for one fetched page — pure, so it can be tested without the network. */
export function judge(html, domain, country) {
  const hit = looksNonRetail(html);
  if (hit) return { ok: false, why: "non_retail", term: hit };
  if (!ECOM.test(html)) return { ok: false, why: "no_commerce_action" };
  const prices = localPrices(html, country);
  if (prices < 2) return { ok: false, why: "no_local_prices" };
  let name = extractName(html);
  if (name && name.length > 24) name = name.split(/\s+-\s+/)[0].trim();   // "Brand - tagline" (extractName splits only | – — ·)
  if (!name || badName(name, domain)) return { ok: false, why: "no_name" };
  return { ok: true, name, platform: BAGISTO.test(html) ? "Bagisto" : null };
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL not set (--env-file=.env.local)"); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: Math.min(CONC + 1, 4), idle_timeout: 20 });
  try {
    await sql`SET statement_timeout = 120000`;
    const rows = await sql`
      SELECT domain, country, name, country_source FROM imported_stores
       WHERE NOT published AND lower(platform) = 'custom'
         AND country = ANY(${countries})
         AND (live_status IS NULL OR live_status NOT IN ('dead', 'migrated'))
         AND activity_tier IS DISTINCT FROM 'not_a_store'
         AND domain !~* ${NON_PROD_HOST}
         AND (cms_confirm_at IS NULL OR cms_confirm_at < now() - CASE WHEN live_status = 'active' THEN interval '30 days' ELSE interval '7 days' END)
       ORDER BY crux_rank NULLS LAST, discovered_at DESC NULLS LAST
       LIMIT ${LIMIT}`;
    console.log(`confirm-custom: ${rows.length} banked custom store(s) in ${cArg ? countries.join(",") : "visible markets"}, conc ${CONC}${DRY ? " [DRY]" : ""}\n`);
    const why = {}; const byCc = {}; let i = 0, done = 0, published = 0, shown = 0;
    async function worker() {
      while (i < rows.length) {
        const r = rows[i++];
        const page = await fetchHome(r.domain);
        let verdict;
        // Any fetch failure (incl. an off-site redirect) only stamps the attempt; liveness is left to its own lanes.
        if (page.fail) verdict = { ok: false, why: page.fail, unreachable: true };
        else verdict = judge(page.html, r.domain, r.country);
        why[verdict.ok ? "published" : verdict.why] = (why[verdict.ok ? "published" : verdict.why] || 0) + 1;
        if (verdict.ok) { published++; byCc[r.country] = (byCc[r.country] || 0) + 1; }
        if (DRY) {
          if ((verdict.ok && shown < 40) || VERBOSE) { shown++; console.log(`${verdict.ok ? "✓ PUBLISH" : "  skip   "}  ${r.domain} [${r.country}]  ${verdict.ok ? `"${verdict.name}"${verdict.platform ? ` → ${verdict.platform}` : ""}` : `${verdict.why}${verdict.term ? ` (${verdict.term})` : ""}`}`); }
        } else if (verdict.ok) {
          const name = r.name && !badName(r.name, r.domain) ? r.name : verdict.name;
          await sql`UPDATE imported_stores SET
              published = true, name = ${name},
              platform = ${verdict.platform ?? sql`platform`},
              country_source = CASE WHEN country_source = 'manual' THEN country_source ELSE 'storefront' END,
              live_status = 'active', live_checked_at = now(), cms_confirm_at = now()
            WHERE domain = ${r.domain} AND NOT published`.catch((e) => console.error(`  ! ${r.domain}: ${e.message}`));
        } else {
          await sql`UPDATE imported_stores SET cms_confirm_at = now()
              ${verdict.unreachable ? sql`` : sql`, live_status = 'active', live_checked_at = now()`}
            WHERE domain = ${r.domain}`.catch(() => {});
        }
        if (++done % 100 === 0) console.log(`  …${done}/${rows.length} (${published} publishable)`);
        await sleep(PAUSE_MS);
      }
    }
    await Promise.all(Array.from({ length: CONC }, worker));
    console.log(`\nDone${DRY ? " [DRY — no writes]" : ""}. ${done} checked · ${published} ${DRY ? "would be " : ""}published.`);
    console.log("by country:", Object.entries(byCc).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" ") || "(none)");
    console.log("outcomes:", Object.entries(why).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" "));
  } finally { await sql.end(); }
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error("failed:", e.message); process.exit(1); });
