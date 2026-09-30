#!/usr/bin/env node
/**
 * Subscription-business detector — a pure HTTP fingerprint probe (NO LLM, no cost).
 * Flags which stores run a SUBSCRIPTION model and records the subscription TOOLING
 * (Recharge / Appstle / Bold / Skio / Loop / Smartrr / Seal / PayWhirl / Ordergroove /
 * Shopify Subscriptions / Woo Subscriptions) into imported_stores.subscription_tools.
 *
 *   node --env-file=.env.local scripts/detect-subscriptions.mjs                 # next 500 by value
 *   node --env-file=.env.local scripts/detect-subscriptions.mjs --limit 100
 *   node --env-file=.env.local scripts/detect-subscriptions.mjs --country ZA,KE
 *   node --env-file=.env.local scripts/detect-subscriptions.mjs --dry           # probe + print, no writes
 *   node --env-file=.env.local scripts/detect-subscriptions.mjs --reprobe-days 90
 *
 * Two detection lanes:
 *  - Lane 1 (Shopify, native OR any subscription app): fetch products.json?limit=1 → the first
 *    product's handle → /products/<handle>.js and /products/<handle> (HTML). A store is a
 *    subscription store if EITHER signal fires:
 *      (a) the product .js exposes a NON-EMPTY `selling_plan_groups` (native Shopify
 *          Subscriptions / Recharge / any app that uses Shopify's native selling plans), OR
 *      (b) the product-page HTML carries a VENDOR-SPECIFIC subscription-app fingerprint.
 *    The tool is named from the same HTML fingerprint; a native selling_plan_groups with no
 *    app fingerprint records "Shopify Subscriptions".
 *  - Lane 2 (WooCommerce): fetch the Store API products and look for any product whose
 *    `type` is `subscription` / `variable-subscription` → "Woo Subscriptions".
 *
 * Fingerprint note (from live testing, 2026-09-29): the task's original plan keyed Lane 1 on
 * `selling_plan_groups` alone and named the tool with a LOOSE fingerprint (bare `bold`,
 * bare `seal`, etc.). Live probing showed two problems, so the fingerprints below are
 * VENDOR-SPECIFIC instead of the bare words:
 *   1. App stores that inject subscriptions client-side (Bold/Appstle/Seal — e.g.
 *      mountainfalls.co.za, thepapery.co.za, 4wks.coffee) expose an EMPTY selling_plan_groups
 *      on every product's .js, so signal (a) alone misses them — signal (b) recovers the ones
 *      that ship a real vendor script (e.g. 4wks → Appstle).
 *   2. The bare-word fingerprint is ~100% false-positive: "bold" (CSS font-weight) + the word
 *      "subscription" (a newsletter link) and "seal"/"skio" as substrings match nearly EVERY
 *      Shopify product page. Bare `bold`/`seal`/`skio` are therefore tightened to vendor
 *      strings (boldapps.net, sealsubscriptions, skio.com …) to keep the flag clean — a
 *      polluted subscription flag would corrupt insights counts. Stores whose subscription
 *      UI is purely client-side with no server-HTML vendor token (mountainfalls, thepapery)
 *      are not detectable via plain HTTP and are correctly left unflagged.
 *
 * Design notes:
 *  - Resumable: stamps subscriptions_checked_at once processed, so a store isn't re-probed
 *    until it goes stale (--reprobe-days, default 60). Even a no-signal store is stamped.
 *  - Authoritative: overwrites subscription_tools (NO COALESCE). A store with no subscription
 *    signal has subscription_tools set to NULL (not "") but is still stamped as checked.
 *  - A total fetch failure (store unreachable) leaves subscription_tools UNCHANGED and only
 *    stamps checked_at, so a transient outage can't wipe a prior detection.
 */

import postgres from "postgres";

const DRY = process.argv.includes("--dry");
const arg = (name, def) => { const i = process.argv.indexOf(name); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def; };
const LIMIT = Number(arg("--limit", 500));
const REPROBE_DAYS = Number(arg("--reprobe-days", 60));
// Concurrency is deliberately LOW: these are Shopify/Woo edge fetches that all share ONE
// residential IP's Shopify-edge rate budget — burst/high concurrency and everything 429s.
const CONCURRENCY = Number(arg("--concurrency", 6));
const cArg = arg("--country", null);
// --platform woocommerce: target only Woo (the lane that hits stores' OWN domains, so it's NOT
// subject to the shared Shopify-edge rate budget — safe to run anytime). Omit for both lanes.
const platArg = (arg("--platform", null) || "").toLowerCase() || null;
const COUNTRIES = cArg ? cArg.toUpperCase().split(",").map((s) => s.trim()).filter(Boolean) : null;
// --domains a.com,b.com: dry-only spot-check that probes exactly these domains (bypassing DB
// selection), for verifying the fingerprint against known stores. Ignored unless --dry.
const dArg = arg("--domains", null);
const DOMAINS = dArg ? dArg.split(",").map((s) => s.trim()).filter(Boolean) : null;

// Focus markets (Africa + JP) — copied from scripts/payments-probe.sh MARKETS. Keep in sync.
const MARKETS = "AO,BW,CI,CM,DZ,EG,ET,GH,KE,LS,LY,MA,MU,MW,MZ,NA,NG,RW,SN,SO,SZ,TN,TZ,UG,ZA,ZM,ZW,JP".split(",");

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const clean = (d) => (d || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");

// A single fetch, ~8s cap, UA header. Returns the Response on 2xx, RATE_LIMITED on 429/503 (a
// TRANSIENT block — the store IS reachable, we just hit the shared Shopify-edge budget), else null.
// Never throws. Callers must NOT record a rate-limited store as "checked" — it must be retried.
const RATE_LIMITED = Symbol("rate_limited");
async function get(url, ms = 8000) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(ms) });
    if (r.status === 429 || r.status === 503) return RATE_LIMITED;
    return r.ok ? r : null;
  } catch { return null; }
}

// VENDOR-SPECIFIC subscription-app fingerprints, applied to the product-page HTML (case-
// insensitive). These are deliberately tighter than the bare app names: bare `bold` (CSS
// font-weight), `seal`, and `skio` matched ~100% of Shopify product pages in live testing
// (proven false-positive), so each is pinned to a real vendor string (script host / handle /
// web-component) that only appears when the app is actually installed. A hit here is a
// positive detection AND the tool name; all matches are collected (multi-app stores are rare
// but real).
function fingerprintShopifyTools(html) {
  const h = (html || "").toLowerCase();
  const tools = [];
  if (/rechargecdn|rechargepayments|recharge[-_]subscription/.test(h)) tools.push("Recharge");
  if (/appstle/.test(h)) tools.push("Appstle");
  if (/boldapps\.net|bold[-_]subscriptions?|boldcommerce|bold_ro\b/.test(h)) tools.push("Bold");
  if (/skio\.com|skio[-_]plan|skio[-_]widget|data-skio|__skio/.test(h)) tools.push("Skio");
  if (/loop[-_]subscription|loopsubscription/.test(h)) tools.push("Loop");
  if (/smartrr/.test(h)) tools.push("Smartrr");
  if (/sealsubscriptions|seal[-_]subscription/.test(h)) tools.push("Seal");
  if (/paywhirl/.test(h)) tools.push("PayWhirl");
  if (/ordergroove/.test(h)) tools.push("Ordergroove");
  return tools;
}

// Lane 1 — Shopify (native or any subscription app). Returns:
//   { reached: bool, tools: string[] }  — reached=false means we couldn't even talk to the store.
async function detectShopify(d) {
  const pj = await get(`https://${d}/products.json?limit=1`);
  if (pj === RATE_LIMITED) return { reached: false, rateLimited: true, tools: [] };
  if (!pj) return { reached: false, tools: [] };
  let handle = null;
  try { handle = ((await pj.json()).products || [])[0]?.handle || null; } catch { /* not shopify / malformed */ }
  if (!handle) return { reached: true, tools: [] }; // reachable but no catalogue → no signal

  let rl = false;
  // Signal (a): native selling plans on the first product's .js.
  const pjs = await get(`https://${d}/products/${encodeURIComponent(handle)}.js`);
  if (pjs === RATE_LIMITED) rl = true;
  let nativeSub = false;
  if (pjs && pjs !== RATE_LIMITED) {
    try {
      const spg = (await pjs.json()).selling_plan_groups;
      nativeSub = Array.isArray(spg) && spg.length > 0;
    } catch { /* not shopify / malformed → no native signal */ }
  }

  // Signal (b): a vendor-specific subscription-app fingerprint in the product-page HTML.
  // Fetched regardless, because client-side apps (Appstle/Recharge/…) leave an empty
  // selling_plan_groups yet ship a detectable vendor script here.
  const page = await get(`https://${d}/products/${encodeURIComponent(handle)}`);
  if (page === RATE_LIMITED) rl = true;
  let tools = [];
  if (page && page !== RATE_LIMITED) tools = fingerprintShopifyTools(await page.text().catch(() => ""));

  // Subscription store if EITHER signal fired. Native-but-unfingerprinted → generic name.
  if (nativeSub && tools.length === 0) tools = ["Shopify Subscriptions"];
  // Rate-limited on the signal endpoints with nothing found → treat as not-reached so we RETRY
  // rather than record a false "no subscription" and lock it out for the whole reprobe window.
  if (tools.length === 0 && rl) return { reached: false, rateLimited: true, tools: [] };
  return { reached: true, tools };
}

// Lane 2 — WooCommerce Subscriptions via the Store API. Returns { reached, tools }.
async function detectWoo(d) {
  let res = await get(`https://${d}/wp-json/wc/store/v1/products?per_page=20`);
  if (res === RATE_LIMITED) return { reached: false, rateLimited: true, tools: [] };
  if (!res) res = await get(`https://${d}/wp-json/wc/store/products?per_page=20`);
  if (res === RATE_LIMITED) return { reached: false, rateLimited: true, tools: [] };
  if (!res) return { reached: false, tools: [] };
  let items = null;
  try { items = await res.json(); } catch { return { reached: true, tools: [] }; }
  if (!Array.isArray(items)) return { reached: true, tools: [] };
  const isSub = items.some((p) => p && (p.type === "subscription" || p.type === "variable-subscription"));
  return { reached: true, tools: isSub ? ["Woo Subscriptions"] : [] };
}

// Probe one store across the relevant lane(s). Returns { reached, tools[] } (deduped).
async function probe(row) {
  const d = clean(row.domain);
  const plat = (row.platform || "").toLowerCase();
  const results = [];
  // Shopify lane for Shopify / unknown platform.
  if (plat === "shopify" || plat === "" || row.platform == null) results.push(await detectShopify(d));
  // Woo lane for WooCommerce.
  if (plat === "woocommerce") results.push(await detectWoo(d));

  // "reached" is true if ANY lane made contact — only an all-lanes failure counts as unreachable.
  const reached = results.some((r) => r.reached);
  // Rate-limited only matters when we didn't reach: it means retry, not "unreachable" (don't stamp).
  const rateLimited = !reached && results.some((r) => r.rateLimited);
  const tools = [...new Set(results.flatMap((r) => r.tools))];
  return { domain: d, reached, rateLimited, tools };
}

async function main() {
  // --domains dry spot-check: probe exactly these domains, no DB needed. For verifying the
  // fingerprint against known stores (the task-sanctioned "tiny inline test mode").
  if (DRY && DOMAINS) {
    console.log(`Spot-checking ${DOMAINS.length} domain(s) [DRY — fingerprint only]…\n`);
    for (const dom of DOMAINS) {
      const r = await probe({ domain: dom, platform: null });
      console.log(`● ${clean(dom)}  ${r.tools.length ? "SUB → " + r.tools.join(";") : r.reached ? "no signal" : "UNREACHABLE"}`);
    }
    return;
  }

  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL not set (--env-file=.env.local)"); process.exit(2); }
  const countries = COUNTRIES || MARKETS;

  const POOL = CONCURRENCY + 1;
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: POOL });
  // Idempotent DDL — IF NOT EXISTS isn't atomic, so swallow a racing "already exists".
  const ddl = async (q) => { try { await q; } catch (e) { if (!/already exists/i.test(e?.message || "")) throw e; } };
  try {
    await ddl(sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS subscription_tools TEXT`);
    await ddl(sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS subscriptions_checked_at TIMESTAMPTZ`);

    // Platform scope: default both supported lanes; --platform narrows to one (woocommerce = the
    // un-rate-limited own-domain lane; shopify = shopify + unclassified CT discoveries).
    const platFilter = platArg === "woocommerce" ? sql`AND LOWER(platform) = 'woocommerce'`
      : platArg === "shopify" ? sql`AND (platform IS NULL OR LOWER(platform) = 'shopify')`
      : sql`AND (platform IS NULL OR LOWER(platform) IN ('shopify', 'woocommerce'))`;
    const rows = await sql`
      SELECT domain, platform FROM imported_stores
      WHERE published
        AND (live_status IS NULL OR live_status NOT IN ('dead', 'migrated'))
        ${platFilter}
        AND UPPER(country) = ANY(${countries})
        AND (subscriptions_checked_at IS NULL
             OR subscriptions_checked_at < now() - (${REPROBE_DAYS} || ' days')::interval)
      ORDER BY estimated_monthly_sales DESC NULLS LAST
      LIMIT ${LIMIT}`;

    if (!rows.length) { console.log("Nothing to probe — all matching stores checked within the re-probe window."); return; }
    console.log(`Probing ${rows.length} store(s)${DRY ? " [DRY]" : ""} at concurrency ${CONCURRENCY} (reprobe > ${REPROBE_DAYS}d)…\n`);

    // Bounded worker pool — NOT Promise.all over the whole batch. A few workers each draining
    // the list keeps concurrency fixed and low (one shared residential IP → Shopify-edge budget)
    // and never overruns the small postgres pool.
    let idx = 0, checked = 0, found = 0, unreachable = 0, ratelimited = 0;
    const byTool = {};
    async function worker() {
      while (idx < rows.length) {
        const row = rows[idx++];
        let r;
        try { r = await probe(row); } catch { r = { domain: clean(row.domain), reached: false, tools: [] }; }
        checked++;
        const tools = r.tools.length ? r.tools.join(";") : null;
        if (tools) { found++; for (const t of r.tools) byTool[t] = (byTool[t] || 0) + 1; }
        if (!r.reached && !r.rateLimited) unreachable++;
        if (r.rateLimited) ratelimited++;

        if (DRY) {
          console.log(`● ${r.domain}  ${tools ? "SUB → " + tools : r.rateLimited ? "RATE-LIMITED (retry)" : r.reached ? "no signal" : "UNREACHABLE"}`);
        } else if (r.reached) {
          // Reached → authoritative overwrite (NO COALESCE): NULL when no signal.
          await sql`UPDATE imported_stores
            SET subscription_tools = ${tools}, subscriptions_checked_at = now()
            WHERE domain = ${r.domain}`;
        } else if (r.rateLimited) {
          // TRANSIENT rate-limit (shared Shopify-edge budget) → leave UNSTAMPED so a later run
          // retries it. Stamping here would lock a reachable store out for the whole reprobe window
          // (the bug that poisoned an entire ZA pass as "checked" with no data).
        } else {
          // Genuine fetch failure (DNS/refused/timeout/404) → stamp checked_at so we don't hammer a
          // dead store forever; it re-enters on the stale re-probe cadence.
          await sql`UPDATE imported_stores
            SET subscriptions_checked_at = now()
            WHERE domain = ${r.domain}`;
        }
        if (checked % 25 === 0 || checked === rows.length) {
          console.log(`— ${checked}/${rows.length}  (${found} subscription, ${unreachable} unreachable, ${ratelimited} rate-limited)`);
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    console.log(`\nDone${DRY ? " [DRY — no writes]" : ""}. ${checked} checked · ${found} subscription store(s) · ${unreachable} unreachable · ${ratelimited} rate-limited (will retry).`);
    const breakdown = Object.entries(byTool).sort((a, b) => b[1] - a[1]);
    if (breakdown.length) {
      console.log("Tool breakdown:");
      for (const [t, n] of breakdown) console.log(`  ${t.padEnd(22)} ${n}`);
    }
  } finally { await sql.end(); }
}

main().catch((e) => { console.error("failed:", e.message); process.exit(1); });
