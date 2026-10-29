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
const APPLY = has("--apply");                       // write: demote confirmed brochures to not_a_store
const LIMIT = Number(arg("--limit", APPLY ? "0" : "400"));   // 0 = whole (resumable) set in --apply
const COUNTRY = arg("--country", "").toUpperCase();
const CONC = Number(arg("--conc", "8"));
const VERBOSE = has("--verbose");
const DOMAINS = arg("--domains", "");

const STORE_APP_ID = "1380b703-ce81-ff05-f115-39571d94dfcd";          // Wix Stores app definition id
// TIGHTENED after validation: a vet + a church both false-positived on the loose markers. Generic
// Wix template JS mentions "ecommerce"/"shopping-cart"/"add to cart" on EVERY site, so those are out.
// Keep only tokens specific to an actually-installed Stores app + a real storefront route.
const reEcom = /wixstores|wix-ecommerce-ooi|ecom-platform|stores\.catalog|wixapps\.net\/stores|ecom-renderer/i;
const reRoute = /\/product-page\/|wix-ecommerce-storefront|"productPage"/i;
const reIsWix = /parastorage\.com|wixstatic\.com|wix-warmup|wixcode|X-Wix|_wixCssStates|static\.parastorage/i;

function classify(text) {
  if (!text || text.length < 200) return { verdict: "unreachable", sig: "" };
  const isWix = reIsWix.test(text);
  const appId = text.includes(STORE_APP_ID);
  const ecom = reEcom.test(text);
  const route = reRoute.test(text);
  const sig = [appId && "appId", ecom && "ecom", route && "route"].filter(Boolean).join("+") || "—";
  if (!isWix) return { verdict: appId || ecom ? "store?" : "not-wix", sig: sig + "(no-wix-markers)" };
  if (appId || ecom || route) return { verdict: "store", sig };
  return { verdict: "brochure", sig: "—" };
}

async function run(domains, pool, sql) {
  const tally = {}; const byCountryStore = {}; let done = 0, demoted = 0;
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(CONC, domains.length) }, async () => {
    while (cursor < domains.length) {
      const { domain, country } = domains[cursor++];
      const r = await fetchText(`https://${domain}`, { proxy: pickProxy(pool), timeoutMs: 12000, maxBytes: 500000 });
      const { verdict, sig } = r && r.status < 400 ? classify(r.text) : { verdict: "unreachable", sig: r ? `http${r.status}` : "net" };
      tally[verdict] = (tally[verdict] ?? 0) + 1;
      if (verdict === "store") byCountryStore[country] = (byCountryStore[country] ?? 0) + 1;
      if (APPLY && verdict === "brochure") {
        // CONSERVATIVE: demote ONLY a reachable, confirmed brochure (still Wix, no store signal).
        // Stores, unreachable (couldn't verify) and churned-off-Wix are left exactly as they are.
        await sql`UPDATE imported_stores SET activity_tier='not_a_store'
          WHERE domain=${domain} AND platform='Wix' AND activity_tier IS DISTINCT FROM 'not_a_store'`
          .then(() => { demoted++; }).catch(() => {});
      }
      if (VERBOSE) console.log(`  ${verdict.padEnd(11)} ${sig.padEnd(14)} ${domain}`);
      if (!VERBOSE && ++done % 25 === 0) process.stdout.write(`\r  probed ${done}/${domains.length}${APPLY ? ` · demoted ${demoted}` : ""}`);
    }
  }));
  return { tally, byCountryStore, demoted };
}

async function main() {
  const pool = loadProxies();
  console.log(`wix-store-audit [READ-ONLY] · proxies: ${pool.length}${pool.length ? "" : " (DIRECT — Wix will block; set STORE_PROBE_PROXY_FILE)"}`);
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
    } else if (APPLY) {
      // Published Wix rows not yet demoted, biggest-market/revenue first.
      domains = await sql`SELECT domain, country FROM imported_stores
        WHERE platform='Wix' AND published=true
          AND activity_tier IS DISTINCT FROM 'not_a_store' AND domain NOT LIKE '%/%' AND domain NOT LIKE '%wixsite%'
        ${COUNTRY ? sql`AND country=${COUNTRY}` : sql``}
        ORDER BY estimated_monthly_sales DESC NULLS LAST, discovered_at DESC NULLS LAST
        ${LIMIT > 0 ? sql`LIMIT ${LIMIT}` : sql``}`;
    } else {
      domains = await sql`SELECT domain, country FROM imported_stores
        WHERE platform='Wix' AND domain NOT LIKE '%/%' AND domain NOT LIKE '%wixsite%'
        ${COUNTRY ? sql`AND country=${COUNTRY}` : sql``}
        ORDER BY random() LIMIT ${LIMIT}`;
    }
    console.log(`${APPLY ? "APPLY (write)" : "sampling"} ${domains.length} Wix domains${COUNTRY ? ` (${COUNTRY})` : ""} · conc ${CONC}\n`);
    const { tally, byCountryStore, demoted } = await run(domains, pool, sql);
    const n = domains.length;
    const reachable = n - (tally.unreachable ?? 0) - (tally["not-wix"] ?? 0);
    console.log(`\n\n=== RESULT (n=${n}) ===`);
    for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(12)} ${v}  (${(100 * v / n).toFixed(1)}%)`);
    const stores = tally.store ?? 0;
    if (reachable > 0) console.log(`\n  STORE RATE among reachable Wix pages: ${stores}/${reachable} = ${(100 * stores / reachable).toFixed(1)}%`);
    if (Object.keys(byCountryStore).length) console.log(`  stores by country:`, byCountryStore);
    if (APPLY) console.log(`\n  ✍ demoted ${demoted} brochures → activity_tier='not_a_store' (hidden from leads + insights; row kept, still published)`);
    else console.log(`\n  (read-only — nothing written)`);
  } catch (e) { console.error("ERR", e.message); process.exitCode = 1; }
  finally { await sql.end(); closeAgents(); }
}
main();
