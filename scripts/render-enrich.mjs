#!/usr/bin/env node
/** render-enrich — tech + payment enrichment for stores the plain-fetch lanes CAN'T read.
 *
 *  deep-enrich.mjs fetches raw HTML with `fetch()`. That fails on two big classes of high-value
 *  store: (a) sites behind a Cloudflare/Akamai JS-challenge (return a 403 "Attention Required" page
 *  to a non-browser), and (b) client-rendered SPAs whose homepage HTML is an empty shell — the tech
 *  and the payment gateway only appear after the JS runs. Both describe most of SA's biggest brands
 *  (Adidas, Decathlon, Verimark, the marketplace giants).
 *
 *  This lane drives a real headless Chromium (Playwright): it renders the page (so challenges pass
 *  and SPAs populate) and — the part plain HTML can never give — records every NETWORK REQUEST host,
 *  which is the most reliable gateway signal there is (a PSP's JS/iframe loads from its own domain,
 *  even when the page never prints its name). Findings UNION into technologies/payments; nothing is
 *  overwritten, and a hand-set or probe-confirmed value always survives.
 *
 *  It is deliberately the SECOND pass: run deep-enrich first (cheap), then this over what it couldn't
 *  reach. Heavier than a fetch, so low concurrency. Own-domain render, so no Shopify-edge budget.
 *
 *    node --env-file=.env.local scripts/render-enrich.mjs --domains a.co.za,b.com --dry
 *    node --env-file=.env.local scripts/render-enrich.mjs --country ZA --limit 100 --concurrency 2
 *    node --env-file=.env.local scripts/render-enrich.mjs                 # default: ZA bot-blocked tail
 */
import postgres from "postgres";
import { chromium } from "playwright";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const DRY = process.argv.includes("--dry");
const LIMIT = Number(arg("--limit", 100));
const CONC = Number(arg("--concurrency", 2));
const NAV_MS = Number(arg("--nav-ms", 25000));
const SETTLE_MS = Number(arg("--settle-ms", 2500));   // let late scripts (gateways, tag managers) fire
const DOMAINS = (arg("--domains", "") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const cArg = arg("--country", null);
const MARKETS = "AO,BW,CI,CM,DZ,EG,ET,GH,KE,LS,LY,MA,MU,MW,MZ,NA,NG,RW,SN,SO,SZ,TN,TZ,UG,ZA,ZM,ZW,JP".split(",");
const countries = cArg ? cArg.split(",").map((c) => c.trim().toUpperCase()) : ["ZA"];
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const clean = (d) => (d || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");

// Tech fingerprints over the RENDERED html. Kept in step with deep-enrich's TECH_FP; add sparingly.
const TECH_FP = [
  [/cdn\.shopify\.com|shopify\.com\/s\/|x-shopify|shopify-features/i, "Shopify"],
  [/woocommerce|wp-content\/plugins\/woocommerce/i, "WooCommerce"],
  [/\/static\/version\d|\/skin\/frontend\/|magento|magentocommerce|mage-cache|data-mage-init|mage\/cookies/i, "Magento"], [/prestashop/i, "PrestaShop"],
  [/vtex\.com|vtexassets/i, "VTEX"], [/wixstatic|wix\.com/i, "Wix"], [/squarespace/i, "Squarespace"],
  [/_next\/static|__next_data__/i, "Next.js"], [/data-reactroot|react(?:-dom)?(?:\.min)?\.js/i, "React"],
  [/vue(?:\.min)?\.js|data-v-[0-9a-f]{8}/i, "Vue.js"], [/ng-version=|angular/i, "Angular"],
  [/cloudflare|cdnjs\.cloudflare|__cf/i, "Cloudflare CDN"], [/akamai/i, "Akamai"],
  [/algolia/i, "Algolia"], [/klaviyo/i, "Klaviyo"], [/gorgias/i, "Gorgias"], [/yotpo/i, "Yotpo"],
  [/cdn\.segment|segment\.com\/analytics/i, "Segment"], [/useinsider|insider\.com/i, "Insider"],
  [/recaptcha|gstatic\.com\/recaptcha/i, "reCAPTCHA"], [/hotjar/i, "Hotjar"],
  [/googletagmanager\.com\/gtm/i, "Google Tag Manager"], [/connect\.facebook\.net|fbevents/i, "Meta Pixel"],
  [/zendesk|zdassets/i, "Zendesk"], [/intercom\.(io|com)|intercomcdn/i, "Intercom"], [/hybris|sap commerce/i, "SAP Hybris"],
];
// Payment fingerprints. A NETWORK-HOST match (loaded the gateway's own domain) is strong; a body
// match is weaker (could be a "we accept" logo) but still a real accepted method. SA-specific tokens
// only — never bare "stripe"/"float"/"visa" (CSS false positives). `host` runs on request hosts.
const PAY_FP = [
  { name: "Peach Payments", host: /peachpayments|ppipn|oppwa/i,  body: /peach\s*payments|peachpayments/i },
  { name: "PayFast",        host: /payfast/i,                    body: /payfast/i },
  { name: "PayU",           host: /payu|payu\.in|payumoney/i,    body: /\bpayu\b/i },
  { name: "Ozow",           host: /ozow/i,                       body: /\bozow\b/i },
  { name: "PayGate",        host: /paygate|dpopay/i,             body: /\bpaygate\b/i },
  { name: "Yoco",           host: /yoco/i,                       body: /\byoco\b/i },
  { name: "SnapScan",       host: /snapscan/i,                   body: /snapscan/i },
  { name: "Zapper",         host: /zapper/i,                     body: /\bzapper\b/i },
  { name: "Adyen",          host: /adyen/i,                      body: /adyen/i },
  { name: "Stitch",         host: /stitch\.money|stitchpayments/i, body: /\bstitch\b.{0,20}pay/i },
  { name: "Stripe",         host: /js\.stripe\.com|stripe\.network/i, body: null },
  { name: "PayJustNow",     host: /payjustnow/i,                 body: /payjustnow|pay\s*just\s*now/i },
  { name: "Payflex",        host: /payflex/i,                    body: /payflex/i },
  { name: "Mobicred",       host: /mobicred/i,                   body: /mobicred/i },
  { name: "Capitec Pay",    host: null,                          body: /capitec\s*pay/i },
  { name: "Happy Pay",      host: /happypay/i,                   body: /happy\s*pay/i },
  { name: "RCS",            host: /rcsgroup|rcs\.co\.za/i,       body: null },
  { name: "Shopify Payments", host: /deposit\.shopifycs|shopifycloud\/checkout/i, body: /shopify\s*payments/i },
];

const union = (cur, add, delim) => {
  const m = new Map();
  (cur || "").split(/;\s*/).forEach((s) => { const k = s.trim().toLowerCase(); if (k && !m.has(k)) m.set(k, s.trim()); });
  add.forEach((s) => { const k = s.trim().toLowerCase(); if (k && !m.has(k)) m.set(k, s.trim()); });
  return [...m.values()].join(delim);
};
const roleOf = (email) => {
  const lp = (email.split("@")[0] || "").toLowerCase();
  if (/^(info|hello|hi|contact|sales|support|help|enquiries|admin|orders|shop|care|service|customer)/.test(lp)) return "role_generic";
  if (/^(owner|founder|ceo|accounts|press|marketing|pr)/.test(lp)) return "role_targeted";
  return /\./.test(lp) || /^[a-z]+$/.test(lp) ? "named" : "role_generic";
};

async function hasCol(sql, c) {
  return (await sql`SELECT 1 FROM information_schema.columns WHERE table_name='imported_stores' AND column_name=${c} LIMIT 1`).length > 0;
}

async function renderOne(browser, domain) {
  // Many SA giants serve a cert whose CN doesn't match the apex/www host we try (faithful-to-nature,
  // etc.). We only READ these homepages (never send credentials), so ignoring cert mismatches recovers
  // that tail at no meaningful risk. User-authorised 2026-10-30.
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, locale: "en-ZA", ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const hosts = new Set();
  page.on("request", (r) => { try { hosts.add(new URL(r.url()).host.toLowerCase()); } catch { /* data: etc */ } });
  try {
    const bare = clean(domain);
    // Try the stored host; on a nav/cert error retry the www-toggled host (apex vs www differ often:
    // cert valid only for www, or apex not served). This is the single most common "unreachable" cause.
    const alt = bare.startsWith("www.") ? bare.slice(4) : "www." + bare;
    let resp;
    try { resp = await page.goto(`https://${bare}/`, { waitUntil: "domcontentloaded", timeout: NAV_MS }); }
    catch { resp = await page.goto(`https://${alt}/`, { waitUntil: "domcontentloaded", timeout: NAV_MS }); }
    await page.waitForTimeout(SETTLE_MS);
    const html = (await page.content()).toLowerCase();
    const mails = await page.$$eval('a[href^="mailto:"]', (as) => as.map((a) => (a.getAttribute("href") || "").slice(7).split("?")[0].trim()).filter(Boolean)).catch(() => []);
    const tels = await page.$$eval('a[href^="tel:"]', (as) => as.map((a) => (a.getAttribute("href") || "").slice(4).trim()).filter(Boolean)).catch(() => []);
    const status = resp ? resp.status() : 0;
    const hostStr = [...hosts].join(" ");
    const tech = TECH_FP.filter(([re]) => re.test(html) || re.test(hostStr)).map(([, n]) => n);
    const pay = PAY_FP.filter((p) => (p.host && p.host.test(hostStr)) || (p.body && p.body.test(html))).map((p) => p.name);
    // own-domain email first (skip free inboxes), else any
    const d2 = clean(domain).replace(/^www\./, "");
    const email = mails.find((m) => m.toLowerCase().endsWith(d2)) || mails.find((m) => !/gmail|yahoo|hotmail|outlook/.test(m)) || mails[0] || null;
    return { ok: status > 0 && status < 400, status, tech, pay, email, phone: tels[0] || null, challenge: /attention required|cf-browser-verification|just a moment/i.test(html) };
  } catch (e) {
    return { ok: false, status: 0, err: (e.message || "").split("\n")[0], tech: [], pay: [] };
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL not set (--env-file=.env.local)"); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3, idle_timeout: 20,
    connection: { statement_timeout: 60000, lock_timeout: 4000, idle_in_transaction_session_timeout: 60000 } });
  try {
    if (!DRY && !(await hasCol(sql, "render_enriched_at"))) {
      await sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS render_enriched_at TIMESTAMPTZ`.catch(() => {});
    }
    // Target: explicit --domains, else the bot-blocked high-value tail — published rows in the focus
    // market(s) that deep-enrich already TRIED (deep_enriched_at set) yet still have no technologies.
    const rows = DOMAINS.length
      ? await sql`SELECT domain, platform, payments, technologies, email FROM imported_stores WHERE domain = ANY(${DOMAINS})`
      : await sql`SELECT domain, platform, payments, technologies, email FROM imported_stores
          WHERE published AND UPPER(country) = ANY(${countries}) AND activity_tier IS DISTINCT FROM 'not_a_store'
            AND (technologies IS NULL OR technologies = '') AND deep_enriched_at IS NOT NULL
            AND (render_enriched_at IS NULL OR render_enriched_at < now() - interval '60 days')
          ORDER BY revenue_ballpark_usd DESC NULLS LAST, crux_rank ASC NULLS LAST
          LIMIT ${LIMIT}`;
    if (!rows.length) { console.log("Nothing to render-enrich."); return; }
    console.log(`render-enrich: ${rows.length} store(s) at concurrency ${CONC}${DRY ? " [DRY]" : ""}…\n`);

    const browser = await chromium.launch({ headless: true });
    let idx = 0, ok = 0, blocked = 0, foundTech = 0, foundPay = 0, foundEmail = 0;
    async function worker() {
      while (idx < rows.length) {
        const r = rows[idx++];
        const res = await renderOne(browser, r.domain);
        if (res.ok) ok++; if (res.challenge || res.status === 403) blocked++;
        const newTech = res.tech.length ? union(r.technologies, res.tech, ";") : r.technologies;
        const newPay = res.pay.length ? union(r.payments, res.pay, "; ") : r.payments;
        if (res.tech.length && newTech !== r.technologies) foundTech++;
        if (res.pay.length && newPay !== r.payments) foundPay++;
        const setEmail = !r.email && res.email ? res.email : null;
        if (setEmail) foundEmail++;
        const tag = res.ok ? "✓" : (res.challenge ? "⛔challenge" : res.status === 403 ? "⛔403" : `✗${res.status || res.err || ""}`);
        console.log(`${tag.padEnd(12)} ${r.domain.padEnd(28)} tech[${res.tech.join(",")}] pay[${res.pay.join(",")}]${setEmail ? " ✉" + setEmail : ""}`);
        if (!DRY) {
          await sql`UPDATE imported_stores SET
              technologies = ${newTech || null}, payments = ${newPay || null},
              ${setEmail ? sql`email = ${setEmail}, contact_type = COALESCE(contact_type, ${roleOf(setEmail)}), contact_checked_at = now(),` : sql``}
              render_enriched_at = now(), deep_enriched_at = now()
            WHERE domain = ${r.domain}`.catch((e) => console.log(`  write failed ${r.domain}: ${e.message}`));
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, rows.length) }, worker));
    await browser.close();
    console.log(`\nDone. ${rows.length} rendered · ${ok} reachable · ${blocked} still blocked · tech+${foundTech} · pay+${foundPay} · email+${foundEmail}`);
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
