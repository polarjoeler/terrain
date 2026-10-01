/**
 * Deep enrichment — ONE homepage fetch per store → theme + plugins/tech + subscription signals, and
 * BANK the cleaned page text for later (free, local) LLM passes (business model, expert/editorial
 * mentions). Fetch is decoupled from analysis: we pay the fetch once, store the text, then re-run
 * regex/LLM over the banked text forever without re-touching the store.
 *
 * PHASE 1 — non-Shopify only (Woo/Wix/Magento/BASE/…). Those are fetched from the stores' OWN
 * servers, so there is NO shared Shopify-edge rate budget — safe to run at normal concurrency.
 * Shopify stores are served from Shopify's edge (rate-limited) and are handled separately (a
 * distributed/proxied fetch lane); pass --platform shopify to opt in once that's wired.
 *
 *   node --env-file=.env.local scripts/deep-enrich.mjs [--country ZA] [--limit 2000] [--concurrency 8] [--dry]
 *   node --env-file=.env.local scripts/deep-enrich.mjs --platform woocommerce --dry   # preview one CMS
 *
 * Non-destructive: theme fills only when empty; plugins/technologies/subscription_tools UNION with
 * existing (never drop a StoreLeads/probe value). Always banks homepage_text + stamps deep_enriched_at.
 */
import postgres from "postgres";

const DRY = process.argv.includes("--dry");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const LIMIT = Number(arg("--limit", 2000));
const CONC = Number(arg("--concurrency", 8));
const REPROBE_DAYS = Number(arg("--reprobe-days", 90));
const cArg = arg("--country", null);
const platArg = (arg("--platform", null) || "").toLowerCase() || null;
const MARKETS = "AO,BW,CI,CM,DZ,EG,ET,GH,KE,LS,LY,MA,MU,MW,MZ,NA,NG,RW,SN,SO,SZ,TN,TZ,UG,ZA,ZM,ZW,JP".split(",");
const countries = cArg ? cArg.split(",").map((c) => c.trim().toUpperCase()) : MARKETS;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const clean = (d) => (d || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");

async function getHtml(domain, ms = 12000) {
  try {
    const r = await fetch(`https://${clean(domain)}/`, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(ms) });
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") || "";
    if (!/html/i.test(ct)) return null;
    return (await r.text()).slice(0, 1_500_000); // cap pathological pages
  } catch { return null; }
}

/* ---- extractors (regex over raw HTML) ------------------------------------- */
// WordPress/Woo theme + plugins live in asset paths. Works for any WP-based store.
const wpTheme = (h) => { const m = h.match(/wp-content\/themes\/([a-z0-9_-]+)/i); return m ? m[1].toLowerCase() : null; };
const wpPlugins = (h) => [...new Set([...h.matchAll(/wp-content\/plugins\/([a-z0-9_-]+)/gi)].map((m) => m[1].toLowerCase()))];

// Generic third-party tech/app fingerprints (script hosts + vendor strings) — platform-agnostic.
const TECH_FP = [
  [/klaviyo/i, "Klaviyo"], [/mailchimp|list-manage\.com/i, "Mailchimp"], [/omnisend/i, "Omnisend"],
  [/yotpo/i, "Yotpo"], [/judge\.?me|judgeme/i, "Judge.me"], [/\bloox\b/i, "Loox"], [/okendo/i, "Okendo"],
  [/gorgias/i, "Gorgias"], [/\btidio\b/i, "Tidio"], [/intercom/i, "Intercom"], [/zendesk/i, "Zendesk"],
  [/hotjar/i, "Hotjar"], [/googletagmanager|gtag\(/i, "Google Tag Manager"], [/connect\.facebook\.net|fbevents/i, "Meta Pixel"],
  [/elementor/i, "Elementor"], [/woocommerce/i, "WooCommerce"], [/cdn\.shopify\.com/i, "Shopify"],
  [/payfast/i, "PayFast"], [/yoco/i, "Yoco"], [/paystack/i, "Paystack"], [/peach\s*payments|peachpayments/i, "Peach Payments"],
];
const techFingerprints = (h) => TECH_FP.filter(([re]) => re.test(h)).map(([, name]) => name);

// Subscription tech fingerprints (same vendors as derive/detect — a hit names the tool).
const SUB_FP = [
  [/woocommerce[-_]subscriptions/i, "Woo Subscriptions"], [/yith[-_]woocommerce[-_]subscription/i, "YITH Subscriptions"],
  [/\bsubscriptio\b|sumo[-_]?subscriptions?/i, "Woo Subscriptions"], [/appstle/i, "Appstle"],
  [/rechargecdn|rechargepayments|recharge[-_]subscription/i, "Recharge"], [/boldapps\.net|bold[-_]subscriptions?/i, "Bold"],
  [/skio\.com|skio[-_]subscription/i, "Skio"], [/loop[-_]subscriptions?/i, "Loop"], [/smartrr/i, "Smartrr"],
  [/sealsubscriptions|seal[-_]subscription/i, "Seal"], [/paywhirl/i, "PayWhirl"], [/ordergroove/i, "Ordergroove"],
];
const SUB_WORDS = /subscription box(es)?|subscribe (?:&|and) save|\bsubscription service\b|monthly (?:box|delivery|supply)|\bauto[-\s]?ship\b/i;
function subTools(h) {
  const t = new Set(SUB_FP.filter(([re]) => re.test(h)).map(([, name]) => name));
  if (!t.size && SUB_WORDS.test(h)) t.add("Subscription (described)");
  return [...t];
}

// Cleaned visible text for the banked blob — strip scripts/styles/tags, collapse whitespace.
function pageText(h) {
  return h.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim().slice(0, 6000);
}

const union = (existing, found) => {
  const e = (existing || "").split(";").map((s) => s.trim()).filter(Boolean);
  return [...new Set([...e, ...found])];
};

async function main() {
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL not set (--env-file=.env.local)"); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: CONC + 1 });
  const ddl = async (q) => { try { await q; } catch (e) { if (!/already exists/i.test(e?.message || "")) throw e; } };
  try {
    await ddl(sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS homepage_text TEXT`);
    await ddl(sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS deep_enriched_at TIMESTAMPTZ`);

    // Default scope: every non-Shopify CMS (own-domain fetch, no Shopify-edge budget).
    const platFilter = platArg
      ? sql`AND LOWER(platform) = ${platArg}`
      : sql`AND platform IS NOT NULL AND LOWER(platform) <> 'shopify'`;
    const rows = await sql`
      SELECT domain, platform, theme, plugins, technologies, subscription_tools
      FROM imported_stores
      WHERE published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
        ${platFilter}
        AND UPPER(country) = ANY(${countries})
        AND (deep_enriched_at IS NULL OR deep_enriched_at < now() - (${REPROBE_DAYS} || ' days')::interval)
      ORDER BY estimated_monthly_sales DESC NULLS LAST
      LIMIT ${LIMIT}`;
    if (!rows.length) { console.log("Nothing to deep-enrich — all matching stores done within the window."); return; }
    console.log(`Deep-enriching ${rows.length} store(s) at concurrency ${CONC}${DRY ? " [DRY]" : ""}…\n`);

    let idx = 0, checked = 0, ok = 0, unreachable = 0, subs = 0;
    async function worker() {
      while (idx < rows.length) {
        const r = rows[idx++];
        checked++;
        const h = await getHtml(r.domain);
        if (!h) { unreachable++; if (!DRY) await sql`UPDATE imported_stores SET deep_enriched_at = now() WHERE domain = ${clean(r.domain)}`.catch(() => {}); continue; }
        ok++;
        const theme = wpTheme(h);
        const plugins = wpPlugins(h);
        const tech = techFingerprints(h);
        const st = subTools(h);
        if (st.length) subs++;
        const newTheme = r.theme || theme;                    // fill-if-empty (don't clobber StoreLeads)
        const newPlugins = union(r.plugins, plugins);
        const newTech = union(r.technologies, tech);
        const newSubs = union(r.subscription_tools, st);
        const text = pageText(h);
        if (DRY) {
          if (checked <= 12) console.log(`● ${clean(r.domain)} [${r.platform}] theme=${newTheme || "-"} plugins=${newPlugins.length} tech=${newTech.length}${st.length ? " SUB→" + st.join(",") : ""}`);
        } else {
          await sql`UPDATE imported_stores SET
            theme = ${newTheme},
            plugins = ${newPlugins.length ? newPlugins.join(";") : null},
            technologies = ${newTech.length ? newTech.join(";") : null},
            subscription_tools = ${newSubs.length ? newSubs.join(";") : null},
            homepage_text = ${text || null},
            deep_enriched_at = now()
          WHERE domain = ${clean(r.domain)}`.catch(() => {});
        }
        if (checked % 25 === 0 || checked === rows.length) console.log(`— ${checked}/${rows.length}  (${ok} scanned, ${unreachable} unreachable, ${subs} subscription)`);
      }
    }
    await Promise.all(Array.from({ length: CONC }, worker));
    console.log(`\nDone${DRY ? " [DRY — no writes]" : ""}. ${checked} checked · ${ok} scanned · ${unreachable} unreachable · ${subs} with a subscription signal.`);
  } finally { await sql.end(); }
}
main().catch((e) => { console.error("failed:", e.message); process.exit(1); });
