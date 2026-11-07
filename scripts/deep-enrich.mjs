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
// Targeted re-scrape of a named set (e.g. the marquee giants), bypassing the platform/country/reprobe
// gates — it fetches exactly these domains whatever their platform or last-enriched date.
const DOMAINS = (arg("--domains", "") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
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
// Add-on/module slugs — NOT WordPress-only. WP/Woo expose plugins under wp-content/plugins; PrestaShop
// and Drupal expose modules under /modules/<slug>/ (read only for those platforms — the path is too
// generic to trust blind). Third-party apps (Klaviyo, Gorgias, …) are caught cross-platform by TECH_FP
// into `technologies`, so every CMS gets its marketing/reviews/support stack regardless.
function cmsPlugins(h, platform) {
  const out = new Set();
  for (const m of h.matchAll(/wp-content\/plugins\/([a-z0-9_-]+)/gi)) out.add(m[1].toLowerCase());
  const p = (platform || "").toLowerCase();
  if (p.includes("presta") || p.includes("drupal")) {
    for (const m of h.matchAll(/\/modules\/([a-z][a-z0-9_-]{2,40})\//gi)) out.add(m[1].toLowerCase());
  }
  return [...out];
}

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
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: CONC + 1,
    connection: { statement_timeout: 120000, idle_in_transaction_session_timeout: 120000, lock_timeout: 3000 } });
  const ddl = async (q) => { try { await q; } catch (e) { if (!/already exists/i.test(e?.message || "")) throw e; } };
  const hasCol = async (c) => (await sql`SELECT 1 FROM information_schema.columns
    WHERE table_name='imported_stores' AND column_name=${c} LIMIT 1`).length > 0;
  try {
    // A no-op ADD COLUMN IF NOT EXISTS STILL grabs ACCESS EXCLUSIVE and, behind a live writer, queues —
    // jamming every other query on the table (the lock-jam class). So skip the ALTER when the column is
    // already there (the normal case); the short lock_timeout above makes even a needed ALTER fail fast
    // rather than freeze the table. Critical now that a 2nd machine (Lucy/Rain) runs this concurrently.
    if (!(await hasCol("homepage_text"))) await ddl(sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS homepage_text TEXT`);
    if (!(await hasCol("deep_enriched_at"))) await ddl(sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS deep_enriched_at TIMESTAMPTZ`);

    // Default scope: every non-Shopify CMS (own-domain fetch, no Shopify-edge budget).
    const platFilter = platArg
      ? sql`AND LOWER(platform) = ${platArg}`
      : sql`AND platform IS NOT NULL AND LOWER(platform) <> 'shopify'`;
    const whereCond = sql`published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
      ${platFilter}
      AND UPPER(country) = ANY(${countries})
      AND (deep_enriched_at IS NULL OR deep_enriched_at < now() - (${REPROBE_DAYS} || ' days')::interval)`;
    // Prioritise FRESH discoveries (discovered_at DESC) — value-ordering buried brand-new no-revenue
    // stores, so they stayed bare. For a single --platform the plain ORDER BY uses idx_imported_discovered
    // (index scan, no sort), fast on the busy DB. For the default multi-CMS run we round-robin ACROSS
    // CMSs: rank each store within its own platform by freshness, then order by that rank first — so every
    // CMS's freshest stores enrich before any CMS's deep tail. Without this, WooCommerce (~11.6k un-enriched
    // vs ~1.8k for every other CMS combined) keeps jumping the queue with fresh discoveries and starves the
    // small platforms (Wix/Magento/Ecwid/…) for days. The candidate set is already filtered to published
    // non-Shopify (~14k rows), so the window-sort is cheap.
    const rows = DOMAINS.length
      ? await sql`
          SELECT domain, platform, theme, plugins, technologies, subscription_tools
          FROM imported_stores WHERE domain = ANY(${DOMAINS})`
      : platArg
      ? await sql`
          SELECT domain, platform, theme, plugins, technologies, subscription_tools
          FROM imported_stores WHERE ${whereCond}
          ORDER BY discovered_at DESC NULLS LAST
          LIMIT ${LIMIT}`
      : await sql`
          WITH cand AS (
            SELECT domain, platform, theme, plugins, technologies, subscription_tools, discovered_at,
                   ROW_NUMBER() OVER (PARTITION BY LOWER(platform) ORDER BY discovered_at DESC NULLS LAST) AS rn
            FROM imported_stores WHERE ${whereCond})
          SELECT domain, platform, theme, plugins, technologies, subscription_tools
          FROM cand
          ORDER BY rn ASC, discovered_at DESC NULLS LAST
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
        const plugins = cmsPlugins(h, r.platform);
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
