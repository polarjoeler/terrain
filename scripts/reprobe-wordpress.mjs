#!/usr/bin/env node
/** reprobe-wordpress — the retroactive pass the banked WordPress pool never got.
 *
 *  The ~51.7k banked `platform='WordPress'` rows were landed with NO plugin data (CT/DNS saw only
 *  "it's WordPress"), so a real store running WooCommerce or a non-Woo commerce plugin (EDD/SureCart/
 *  WP eCommerce/WP EasyCart/Jigoshop/Woo Subscriptions) is indistinguishable from a law-firm blog
 *  until we fetch the homepage. `woo_probe --land` can't fix this (ON CONFLICT DO NOTHING won't UPDATE
 *  an existing row), so this is the dedicated fetch → detect → UPDATE script.
 *
 *  Two modes (same probe+classify core):
 *    --mode wordpress (default): banked platform='WordPress' rows → reclassify.
 *        • WooCommerce / commerce plugin found → relabel platform + publish=true, activity_tier='active'
 *          (being on a dedicated commerce platform IS store confirmation).
 *        • Membership plugin (MemberPress / Paid Memberships Pro) → relabel platform only, stay banked
 *          (membership ≠ retail store; don't auto-surface as a lead).
 *        • Reachable, is WordPress, no commerce, or a holding/parked page → activity_tier='not_a_store'
 *          (kept + reversible, hidden from leads/insights — matches "keep non-stores but label them").
 *        • Unreachable / churned-off-WP → left banked WordPress = the retry pool.
 *    --mode labeled: banked rows already labeled with a WP-commerce plugin (SureCart/EDD/WP eCommerce/
 *        WP EasyCart/Woo Subscriptions) → re-confirm live → publish. (This is the "promote the already-
 *        detected ones" pass for the ~109 that flowed through detection but were never surfaced.)
 *
 *  Resumable with NO schema change (avoids the imported_stores ALTER lock-jam): every terminal outcome
 *  changes platform or activity_tier, so the row drops out of the mode's query; a re-run only re-fetches
 *  the unreachable/churned tail. Fetches go through the Webshare fleet when STORE_PROBE_PROXY_FILE is
 *  set (own-domain WordPress homepages, so NO shared Shopify-edge budget), else direct.
 *
 *    STORE_PROBE_PROXY_FILE=~/shopify-radar/proxies.txt \
 *      node --env-file=.env.local scripts/reprobe-wordpress.mjs [--mode wordpress|labeled]
 *        [--market visible|jp|all] [--country ZA] [--limit N] [--conc 8] [--dry] [--verbose] [--no-publish]
 */
import postgres from "postgres";
import { loadProxies, pickProxy, fetchText, closeAgents } from "./lib/proxy-fetch.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes(k);
const MODE = arg("--mode", "wordpress").toLowerCase();        // wordpress | labeled
const DRY = has("--dry");
const PUBLISH = !has("--no-publish");                          // publish confirmed commerce stores
const LIMIT = Number(arg("--limit", "0"));                    // 0 = whole (resumable) set
const COUNTRY = arg("--country", "").toUpperCase();
const MARKET = arg("--market", "visible").toLowerCase();      // visible | jp | all (wordpress mode scope)
const CONC = Number(arg("--conc", "8"));
const VERBOSE = has("--verbose");

const VISIBLE = ["ZA","KE","NG","EG","MA","GH","TZ","UG","DZ","TN","CI","SN","MU","MZ","CM","BW","AO","NA","RW","ZM","ET","ZW","LY","MW","SO","LS","SZ"];
// WP-commerce plugin fingerprints — ported verbatim from shopify-radar/woo_probe.py _CMS_FINGERPRINTS.
// Order matters: specific commerce carts before the generic WordPress catch-all. `store:true` = a real
// retail store (publish); `store:false` (membership) = relabel only, stays banked.
const WOO = ["wp-content/plugins/woocommerce", 'generator" content="woocommerce', "woocommerce-no-js", "wc-block", "woocommerce-page", "add_to_cart_button"];
const PLUGINS = [
  { plat: "Easy Digital Downloads", store: true, needles: ["plugins/easy-digital-downloads", "edd-add-to-cart", "edd_ajax"] },
  { plat: "SureCart", store: true, needles: ["plugins/surecart", "sc-block", "data-sc-"] },
  { plat: "WP eCommerce", store: true, needles: ["plugins/wp-e-commerce", "wpsc_", "wpsc-"] },
  { plat: "Jigoshop", store: true, needles: ["plugins/jigoshop", "jigoshop"] },
  { plat: "WP EasyCart", store: true, needles: ["plugins/wp-easycart", "ec_cart", "wpeasycart"] },
  { plat: "WooCommerce Subscriptions", store: true, needles: ["plugins/woocommerce-subscriptions"] },
  { plat: "MemberPress", store: false, needles: ["plugins/memberpress", "mepr-", "mp-sign"] },
  { plat: "Paid Memberships Pro", store: false, needles: ["plugins/paid-memberships-pro", "pmpro_"] },
];
const reHolding = /coming soon|under construction|maintenance mode|site will be available|just another wordpress site|account suspended|domain (is )?for sale/i;
const reIsWp = /wp-content|wp-json|wordpress/i;

// → { verdict, plat?, sig }. verdicts: store | membership | brochure | holding | unreachable | churned
function classify(text) {
  if (!text || text.length < 200) return { verdict: "unreachable", sig: "" };
  const hay = text.toLowerCase();
  if (WOO.some((n) => hay.includes(n))) return { verdict: "store", plat: "WooCommerce", sig: "woo" };
  for (const p of PLUGINS) {
    if (p.needles.some((n) => hay.includes(n))) {
      return { verdict: p.store ? "store" : "membership", plat: p.plat, sig: p.plat };
    }
  }
  if (reHolding.test(text)) return { verdict: "holding", sig: "holding/parked" };
  if (!reIsWp.test(text)) return { verdict: "churned", sig: "no-wp-markers" };
  return { verdict: "brochure", sig: "wp, no-commerce" };
}

async function run(rows, pool, sql) {
  const tally = {}; const byPlat = {}; let done = 0, published = 0, relabeled = 0, demoted = 0;
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(CONC, rows.length) }, async () => {
    while (cursor < rows.length) {
      const { domain } = rows[cursor++];
      const r = await fetchText(`https://${domain}`, { proxy: pickProxy(pool), timeoutMs: 12000, maxBytes: 600000 });
      const { verdict, plat, sig } = r && r.status < 400 ? classify(r.text) : { verdict: "unreachable", sig: r ? `http${r.status}` : "net" };
      tally[verdict] = (tally[verdict] ?? 0) + 1;
      if (plat && (verdict === "store" || verdict === "membership")) byPlat[plat] = (byPlat[plat] ?? 0) + 1;
      if (!DRY) {
        if (verdict === "store" && PUBLISH) {
          await sql`UPDATE imported_stores SET platform=${plat}, published=true, activity_tier='active'
            WHERE domain=${domain} AND published=false`.then((x) => { if (x.count) published++; }).catch(() => {});
        } else if (verdict === "store" && !PUBLISH) {
          await sql`UPDATE imported_stores SET platform=${plat}
            WHERE domain=${domain} AND platform='WordPress'`.then((x) => { if (x.count) relabeled++; }).catch(() => {});
        } else if (verdict === "membership") {
          await sql`UPDATE imported_stores SET platform=${plat}
            WHERE domain=${domain} AND platform='WordPress'`.then((x) => { if (x.count) relabeled++; }).catch(() => {});
        } else if ((verdict === "brochure" || verdict === "holding") && MODE === "wordpress") {
          // Confirmed non-store: keep the row, label it (reversible), drop from leads + the reprobe pool.
          // wordpress-mode ONLY — never demote an already-labeled commerce row on a homepage miss
          // (SureCart's block markers often live on product pages, not the homepage → false negatives).
          await sql`UPDATE imported_stores SET activity_tier='not_a_store'
            WHERE domain=${domain} AND activity_tier IS DISTINCT FROM 'not_a_store'`.then((x) => { if (x.count) demoted++; }).catch(() => {});
        }
        // unreachable / churned → no write, left banked as the retry pool
      }
      if (VERBOSE) console.log(`  ${verdict.padEnd(11)} ${(plat || sig).padEnd(24)} ${domain}`);
      else if (++done % 50 === 0) process.stdout.write(`\r  probed ${done}/${rows.length} · pub ${published} · relabel ${relabeled} · label-nonstore ${demoted}`);
    }
  }));
  return { tally, byPlat, published, relabeled, demoted };
}

async function main() {
  const pool = loadProxies();
  console.log(`reprobe-wordpress [mode=${MODE}] · proxies: ${pool.length || "DIRECT"}${DRY ? " · DRY" : ""}`);
  const sql = postgres(process.env.DATABASE_URL, { ssl: "require", max: 3, prepare: false,
    connection: { statement_timeout: 30000, idle_in_transaction_session_timeout: 60000, lock_timeout: 5000 } });
  try {
    const scope = MARKET === "jp" ? ["JP"] : MARKET === "all" ? null : VISIBLE;
    let rows;
    if (MODE === "labeled") {
      // Already-detected WP-commerce stores sitting banked → re-confirm live, then publish.
      const COMMERCE = ["SureCart", "Easy Digital Downloads", "WP eCommerce", "WP EasyCart", "WooCommerce Subscriptions", "Jigoshop"];
      rows = await sql`SELECT domain, country FROM imported_stores
        WHERE platform = ANY(${COMMERCE}) AND published=false AND activity_tier IS DISTINCT FROM 'not_a_store'
          AND domain NOT LIKE '%/%'
        ${COUNTRY ? sql`AND country=${COUNTRY}` : sql``}
        ORDER BY estimated_monthly_sales DESC NULLS LAST, discovered_at DESC NULLS LAST
        ${LIMIT > 0 ? sql`LIMIT ${LIMIT}` : sql``}`;
    } else {
      rows = await sql`SELECT domain, country FROM imported_stores
        WHERE platform='WordPress' AND published=false AND activity_tier IS DISTINCT FROM 'not_a_store'
          AND domain NOT LIKE '%/%'
        ${COUNTRY ? sql`AND country=${COUNTRY}` : scope ? sql`AND country = ANY(${scope})` : sql``}
        ORDER BY estimated_monthly_sales DESC NULLS LAST, discovered_at DESC NULLS LAST
        ${LIMIT > 0 ? sql`LIMIT ${LIMIT}` : sql``}`;
    }
    console.log(`${DRY ? "DRY " : ""}probing ${rows.length} rows${COUNTRY ? ` (${COUNTRY})` : MODE === "wordpress" ? ` (market=${MARKET})` : ""} · conc ${CONC}\n`);
    const { tally, byPlat, published, relabeled, demoted } = await run(rows, pool, sql);
    const n = rows.length;
    console.log(`\n\n=== RESULT (n=${n}) ===`);
    for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(12)} ${v}  (${(100 * v / n).toFixed(1)}%)`);
    if (Object.keys(byPlat).length) console.log(`  by platform:`, byPlat);
    if (!DRY) console.log(`\n  ✍ published ${published} commerce stores → live · relabeled ${relabeled} (membership/no-publish) · labeled ${demoted} non-stores → not_a_store`);
    else console.log(`\n  (dry — nothing written)`);
  } catch (e) { console.error("ERR", e.message); process.exitCode = 1; }
  finally { await sql.end(); closeAgents(); }
}
main();
