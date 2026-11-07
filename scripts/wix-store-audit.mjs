#!/usr/bin/env node
/** wix-store-audit — READ-ONLY measurement: of the rows we label platform='Wix', how many actually
 *  run the Wix STORES (commerce) product vs are brochure/service sites (a vet, a church, a tour
 *  operator — all currently mislabelled as "stores"). Writes NOTHING; it only fetches + tallies.
 *
 *  Wix bot-blocks the bare residential IP (plain GETs come back empty), so every fetch goes through
 *  the Webshare fleet (STORE_PROBE_PROXY_FILE), one proxy per request, via ./lib/proxy-fetch.mjs.
 *
 *  Store signal (from the server-rendered homepage HTML — Wix embeds its installed-app list there):
 *    • the Wix Stores app's well-known appDefinitionId 1380b703-ce81-ff05-f115-39571d94dfcd, or
 *    • an ecommerce bundle/marker (wixstores / wix-ecommerce / ecom-platform / stores.catalog), or
 *    • a storefront route (/product-page/) or cart marker.
 *  We also confirm the page is still Wix at all (parastorage/wixstatic/wix-warmup) to catch domains
 *  that churned off Wix since we tagged them.
 *
 *    STORE_PROBE_PROXY_FILE=~/shopify-radar/proxies.txt \
 *      node --env-file=.env.local scripts/wix-store-audit.mjs --limit 400 [--country ZA] [--conc 8]
 *    ... --domains a.co.za,b.co.za --verbose     # validate the detector on specific domains
 */
import postgres from "postgres";
import { loadProxies, pickProxy, fetchText, closeAgents } from "./lib/proxy-fetch.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes(k);
const APPLY = has("--apply");                       // write: demote confirmed brochures (published rows) to not_a_store
const PROMOTE = has("--promote");                   // write: surface banked (published=false) builder STORES → published=true
const DRY = has("--dry");                            // with --promote: classify + report, write nothing
const WRITE = (APPLY || PROMOTE) && !DRY;
const LIMIT = Number(arg("--limit", APPLY || PROMOTE ? "0" : "400"));   // 0 = whole (resumable) set
const COUNTRY = arg("--country", "").toUpperCase();
const CONC = Number(arg("--conc", "8"));
const VERBOSE = has("--verbose");
const DOMAINS = arg("--domains", "");
const BUILDER = arg("--builder", "wix").toLowerCase();   // wix (default) | squarespace | webflow
// Dashboard-visible markets (inline — standalone scripts can't resolve the @/ alias; keep in sync with lib/markets.ts).
const VISIBLE = ["ZA","KE","NG","EG","MA","GH","TZ","UG","DZ","TN","CI","SN","MU","MZ","CM","BW","AO","NA","RW","ZM","ET","ZW","LY","MW","SO","LS","SZ"];

// Per-builder commerce detection. The recurring trap (learned on Wix: a vet + a church false-positived)
// is that a builder's UNIVERSAL template/runtime JS mentions generic ecommerce words ("cart", "ecommerce",
// "add to cart") on EVERY site it serves, store or not. So each builder's `ecom`/`route` markers are
// restricted to tokens a platform only emits when a real store/commerce product is actually installed
// (an installed-app id, a commerce-specific CSS class prefix, a rendered storefront route), never the
// generic runtime words. `isPlatform` just confirms the page is still that builder (catches churn-off).
const BUILDERS = {
  wix: {
    platform: "Wix",
    // Wix Stores app definitionId is the rock-solid anchor; ecom bundle + storefront route back it up.
    isPlatform: /parastorage\.com|wixstatic\.com|wix-warmup|wixcode|X-Wix|_wixCssStates|static\.parastorage/i,
    storeId: "1380b703-ce81-ff05-f115-39571d94dfcd",
    reEcom: /wixstores|wix-ecommerce-ooi|ecom-platform|stores\.catalog|wixapps\.net\/stores|ecom-renderer/i,
    reRoute: /\/product-page\/|wix-ecommerce-storefront|"productPage"/i,
  },
  squarespace: {
    platform: "Squarespace",
    // Commerce code is bundled into every SQSP site's runtime, so plain "commerce" is worthless. A real
    // store RENDERS a product block (sqs-add-to-cart-button / add-to-cart-button) or carries product-item
    // data attributes; those only appear with a Commerce product + a published product.
    // VALIDATED 2026-10-30: the SQUARESPACE_CONTEXT commerce flag (commerceEnabled/storeSettings) is
    // present on EVERY SQSP site incl. brochures — useless. The `add-to-cart-button` class is RENDERED
    // only with a real product block/page: present on 7/7 stores, absent on 8/8 brochures. That's the anchor.
    isPlatform: /static1\.squarespace|squarespace-cdn|sqsp\.net|Static\.SQUARESPACE_CONTEXT|squarespace\.com\/universal/i,
    reEcom: /sqs-add-to-cart-button|add-to-cart-button|sqs-money-native|physical-product-page|digital-product-page/i,
    reRoute: /data-item-id="[0-9a-f]{12,}|"productItem"/i,
  },
  webflow: {
    platform: "Webflow",
    // Webflow Ecommerce emits the `w-commerce-commerce*` class family and commerce node-types ONLY when
    // ecommerce is enabled; generic `data-wf-collection` is any CMS list (blog), so it's excluded.
    isPlatform: /website-files\.com|assets\.website-files|data-wf-site|data-wf-page|Webflow\.require/i,
    reEcom: /w-commerce-commerce|wf-ecommerce|"ecommerce":\{|data-wf-collection-item-commerce/i,
    reRoute: /data-node-type="commerce-|w-commerce-commerceaddtocart|\/checkout\/[a-z]/i,
  },
};
const CFG = BUILDERS[BUILDER];
if (!CFG) { console.error(`unknown --builder ${BUILDER} (use: ${Object.keys(BUILDERS).join(" | ")})`); process.exit(1); }
const PLATFORM = CFG.platform;
const NOTPLAT = `not-${BUILDER}`;

function classify(text) {
  if (!text || text.length < 200) return { verdict: "unreachable", sig: "" };
  const isPlat = CFG.isPlatform.test(text);
  const storeId = CFG.storeId ? text.includes(CFG.storeId) : false;
  const ecom = CFG.reEcom.test(text);
  const route = CFG.reRoute.test(text);
  const sig = [storeId && "appId", ecom && "ecom", route && "route"].filter(Boolean).join("+") || "—";
  if (!isPlat) return { verdict: storeId || ecom ? "store?" : NOTPLAT, sig: sig + `(no-${BUILDER}-markers)` };
  if (storeId || ecom || route) return { verdict: "store", sig };
  return { verdict: "brochure", sig: "—" };
}

async function run(domains, pool, sql) {
  const tally = {}; const byCountryStore = {}; let done = 0, demoted = 0, promoted = 0;
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(CONC, domains.length) }, async () => {
    while (cursor < domains.length) {
      const { domain, country } = domains[cursor++];
      const r = await fetchText(`https://${domain}`, { proxy: pickProxy(pool), timeoutMs: 12000, maxBytes: 500000 });
      const { verdict, sig } = r && r.status < 400 ? classify(r.text) : { verdict: "unreachable", sig: r ? `http${r.status}` : "net" };
      tally[verdict] = (tally[verdict] ?? 0) + 1;
      if (verdict === "store") byCountryStore[country] = (byCountryStore[country] ?? 0) + 1;
      if (WRITE && PROMOTE) {
        // Surface banked Wix STORES; demote confirmed brochures out of the retry pool. Both outcomes
        // drop out of the --promote query (published / not_a_store), so the lane is resumable with no
        // marker column. Unreachable + not-wix stay published=false = the retry pool for a later pass.
        if (verdict === "store") {
          await sql`UPDATE imported_stores SET published=true, activity_tier='active'
            WHERE domain=${domain} AND platform=${PLATFORM} AND published=false`
            .then((res) => { if (res.count) promoted++; }).catch(() => {});
        } else if (verdict === "brochure") {
          await sql`UPDATE imported_stores SET activity_tier='not_a_store'
            WHERE domain=${domain} AND platform=${PLATFORM} AND activity_tier IS DISTINCT FROM 'not_a_store'`
            .then(() => { demoted++; }).catch(() => {});
        }
      } else if (WRITE && APPLY && verdict === "brochure") {
        // CONSERVATIVE cleanup of PUBLISHED rows: demote only a reachable, confirmed brochure.
        await sql`UPDATE imported_stores SET activity_tier='not_a_store'
          WHERE domain=${domain} AND platform=${PLATFORM} AND activity_tier IS DISTINCT FROM 'not_a_store'`
          .then(() => { demoted++; }).catch(() => {});
      }
      if (VERBOSE) console.log(`  ${verdict.padEnd(11)} ${sig.padEnd(14)} ${domain}`);
      if (!VERBOSE && ++done % 25 === 0) process.stdout.write(`\r  probed ${done}/${domains.length}${PROMOTE ? ` · promoted ${promoted} · demoted ${demoted}` : APPLY ? ` · demoted ${demoted}` : ""}`);
    }
  }));
  return { tally, byCountryStore, demoted, promoted };
}

async function main() {
  const pool = loadProxies();
  console.log(`builder-store-audit [${PLATFORM}] · proxies: ${pool.length}${pool.length ? "" : " (DIRECT — builder may block; set STORE_PROBE_PROXY_FILE)"}`);
  const sql = postgres(process.env.DATABASE_URL, { ssl: "require", max: 3, prepare: false,
    connection: { statement_timeout: 30000, idle_in_transaction_session_timeout: 60000, lock_timeout: 5000 } });
  try {
    // No schema change on purpose: an ALTER on imported_stores takes ACCESS EXCLUSIVE and, behind the
    // live enrich writers, is the lock-jam that froze the table before. We don't need a resume column
    // — the demote (activity_tier='not_a_store') is durable and the APPLY query excludes already-
    // demoted rows, so a re-run just re-reads the still-store/unreachable rows (wasted fetches, no harm).
    let domains;
    if (DOMAINS) {
      domains = DOMAINS.split(",").map((d) => ({ domain: d.trim(), country: "?" }));
    } else if (PROMOTE) {
      // Banked (published=false) Wix in DASHBOARD-VISIBLE markets only — promoting elsewhere surfaces
      // nothing. Skip already-demoted; biggest-revenue/newest first so the best leads land first.
      domains = await sql`SELECT domain, country FROM imported_stores
        WHERE platform=${PLATFORM} AND published=false AND country = ANY(${COUNTRY ? [COUNTRY] : VISIBLE})
          AND activity_tier IS DISTINCT FROM 'not_a_store' AND domain NOT LIKE '%/%' AND domain NOT LIKE '%wixsite%'
        ORDER BY estimated_monthly_sales DESC NULLS LAST, discovered_at DESC NULLS LAST
        ${LIMIT > 0 ? sql`LIMIT ${LIMIT}` : sql``}`;
    } else if (APPLY) {
      // Published builder rows not yet demoted, biggest-market/revenue first.
      domains = await sql`SELECT domain, country FROM imported_stores
        WHERE platform=${PLATFORM} AND published=true
          AND activity_tier IS DISTINCT FROM 'not_a_store' AND domain NOT LIKE '%/%' AND domain NOT LIKE '%wixsite%'
        ${COUNTRY ? sql`AND country=${COUNTRY}` : sql``}
        ORDER BY estimated_monthly_sales DESC NULLS LAST, discovered_at DESC NULLS LAST
        ${LIMIT > 0 ? sql`LIMIT ${LIMIT}` : sql``}`;
    } else {
      domains = await sql`SELECT domain, country FROM imported_stores
        WHERE platform=${PLATFORM} AND domain NOT LIKE '%/%' AND domain NOT LIKE '%wixsite%'
        ${COUNTRY ? sql`AND country=${COUNTRY}` : sql``}
        ORDER BY random() LIMIT ${LIMIT}`;
    }
    const mode = PROMOTE ? (DRY ? "PROMOTE [DRY]" : "PROMOTE (write)") : APPLY ? "APPLY (write)" : "sampling";
    console.log(`${mode} ${domains.length} ${PLATFORM} domains${COUNTRY ? ` (${COUNTRY})` : PROMOTE ? " (banked, visible markets)" : ""} · conc ${CONC}\n`);
    const { tally, byCountryStore, demoted, promoted } = await run(domains, pool, sql);
    const n = domains.length;
    const reachable = n - (tally.unreachable ?? 0) - (tally[NOTPLAT] ?? 0);
    console.log(`\n\n=== RESULT (n=${n}) ===`);
    for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(12)} ${v}  (${(100 * v / n).toFixed(1)}%)`);
    const stores = tally.store ?? 0;
    if (reachable > 0) console.log(`\n  STORE RATE among reachable ${PLATFORM} pages: ${stores}/${reachable} = ${(100 * stores / reachable).toFixed(1)}%`);
    if (Object.keys(byCountryStore).length) console.log(`  stores by country:`, byCountryStore);
    if (PROMOTE && !DRY) console.log(`\n  ✍ promoted ${promoted} banked ${PLATFORM} STORES → published=true, activity_tier='active' (now live leads) · demoted ${demoted} brochures → not_a_store`);
    else if (APPLY) console.log(`\n  ✍ demoted ${demoted} brochures → activity_tier='not_a_store' (hidden from leads + insights; row kept, still published)`);
    else console.log(`\n  (read-only — nothing written)`);
  } catch (e) { console.error("ERR", e.message); process.exitCode = 1; }
  finally { await sql.end(); closeAgents(); }
}
main();
