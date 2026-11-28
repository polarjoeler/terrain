/** classify-wix-selling — tag Wix leads that sell nothing as not selling, and bookings-only sites as services.
 *
 *  Wix leads are mostly not shops: of 1,162 ZA/KE/NG Wix leads read 2026-11-28, half have the Wix Stores
 *  app and ~40% of those list no products. Joel 11-28: keep every Wix lead, but tag the ones that do not
 *  sell, and keep bookings/tickets/plans sites as leads tagged separately. So nothing is hidden here:
 *
 *    products   (shop with products, or an ordering app)  activity_tier stays; 'dormant' set by this lane → 'selling'
 *    services   (bookings, tickets, plans, pay buttons)    biz_model = 'services'; tier as for products
 *    empty_shop (Wix Stores installed, no products)        activity_tier = 'dormant' ("built, not selling")
 *    brochure   (app list read, nothing in it sells)       activity_tier = 'dormant'
 *    unknown    (no app list, unreadable sitemap, off Wix)  untouched
 *
 *  'dormant' keeps the row a lead (only 'not_a_store' leaves the list), shows as "Dormant (built, not
 *  selling)" in the activity filter, and ranks with lib/score.ts's dormant weight. wix-probe leaves a
 *  published row's 'dormant' alone, so this lane owns it; re-run it to pick up shops that add products.
 *
 *  Classification: lib/wix-selling.mjs over the homepage's app list (platform-addons wixApps) and, only
 *  when Wix Stores is the sole selling app, /sitemap.xml. Wix blocks the bare residential IP, so both go
 *  through the proxy fleet (STORE_PROBE_PROXY_FILE). A person's activity_tier edit in store_edits is never
 *  overwritten; every tier change writes its own store_edits row.
 *
 *    STORE_PROBE_PROXY_FILE=~/shopify-radar/proxies.txt node --env-file=.env.local scripts/classify-wix-selling.mjs --dry
 *    ... [--country ZA,KE,NG] [--limit 500] [--concurrency 6] [--domains a.co.za,b.co.za]
 */
import postgres from "postgres";
import { loadProxies, pickProxy, fetchText, closeAgents } from "./lib/proxy-fetch.mjs";
import { wixApps } from "./lib/platform-addons.mjs";
import { classifyWix, sitemapHasProducts, needsSitemap } from "./lib/wix-selling.mjs";

const DRY = process.argv.includes("--dry");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const LIMIT = Number(arg("--limit", 0));
const CONC = Number(arg("--concurrency", 6));
const COUNTRIES = arg("--country", null)?.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean) ?? null;
const DOMAINS = arg("--domains", null)?.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean) ?? null;
const EDITOR = "lane:classify-wix-selling";
const NOT_SELLING = new Set(["empty_shop", "brochure"]);
const IS_WIX = /static\.parastorage\.com|wixstatic\.com|"appDefinitionName"|wix-warmup/;

const proxies = loadProxies();
const get = async (url) => {
  for (let i = 0; i < 2; i++) {
    const r = await fetchText(url, { proxy: pickProxy(proxies), timeoutMs: 15_000, maxBytes: 3_000_000 });
    if (r && r.status < 500 && r.status !== 429) return r;
  }
  return null;
};

async function judge(domain) {
  const home = await get(`https://${domain}/`);
  if (!home || home.status !== 200) return { verdict: "unknown", why: home ? `HTTP ${home.status}` : "unreachable", reach: false };
  if (!IS_WIX.test(home.text)) return { verdict: "unknown", why: "not Wix any more" };
  const apps = wixApps(home.text);
  const appListRead = /"appDefinitionName"/.test(home.text);
  let hasProducts;
  if (appListRead && needsSitemap(apps)) {
    const sm = await get(`https://${domain}/sitemap.xml`);
    hasProducts = sm && sm.status === 200 ? sitemapHasProducts(sm.text) : null;
  }
  return { ...classifyWix({ apps, appListRead, hasProducts }), apps };
}

async function mapLimit(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3, idle_timeout: 20 });
try {
  const rows = await sql`
    SELECT s.domain, s.country, s.activity_tier, s.biz_model,
           (SELECT e.editor FROM store_edits e WHERE e.domain = s.domain AND e.field = 'activity_tier'
             ORDER BY e.edited_at DESC, e.id DESC LIMIT 1) AS tier_editor
      FROM imported_stores s
     WHERE s.published AND lower(s.platform) = 'wix'
       AND s.live_status IS DISTINCT FROM 'dead' AND s.live_status IS DISTINCT FROM 'migrated'
       AND s.activity_tier IS DISTINCT FROM 'not_a_store'
       ${COUNTRIES ? sql`AND s.country = ANY(${COUNTRIES})` : sql``}
       ${DOMAINS ? sql`AND s.domain = ANY(${DOMAINS})` : sql``}
     ORDER BY s.domain
     ${LIMIT ? sql`LIMIT ${LIMIT}` : sql``}`;
  console.log(`classify-wix-selling: ${rows.length} published Wix leads · ${proxies.length} proxies · conc ${CONC}${DRY ? " [DRY]" : ""}`);
  if (!proxies.length) console.log("!! no proxies loaded: Wix blocks the bare IP, expect mostly unknown");

  const tally = {}, byMarket = {}, writes = { dormant: 0, selling: 0, services: 0, skippedManual: 0, failed: 0 };
  let done = 0;
  await mapLimit(rows, CONC, async (r) => {
    const j = await judge(r.domain);
    tally[j.verdict] = (tally[j.verdict] ?? 0) + 1;
    const mk = ["ZA", "KE", "NG"].includes(r.country) ? r.country : "other";
    (byMarket[mk] ??= {})[j.verdict] = (byMarket[mk][j.verdict] ?? 0) + 1;
    if (++done % 250 === 0) console.log(`  … ${done}/${rows.length}`);
    if (DRY && j.verdict !== "unknown" && Math.random() < 0.02) console.log(`  ${j.verdict.padEnd(10)} ${r.country ?? "--"} ${r.domain.padEnd(36)} ${j.why}`);
    if (j.verdict === "unknown") return;

    const manual = r.tier_editor && !String(r.tier_editor).startsWith("lane:");
    let tier = r.activity_tier;
    if (NOT_SELLING.has(j.verdict) && tier !== "dormant") tier = "dormant";
    if (!NOT_SELLING.has(j.verdict) && tier === "dormant" && r.tier_editor === EDITOR) tier = "selling";
    const tierChange = tier !== r.activity_tier;
    if (tierChange && manual) { writes.skippedManual++; tier = r.activity_tier; }
    const services = j.verdict === "services" && r.biz_model !== "services";
    if (!(tier !== r.activity_tier) && !services) return;
    if (tier !== r.activity_tier) writes[tier === "dormant" ? "dormant" : "selling"]++;
    if (services) writes.services++;
    if (DRY) return;
    await sql.begin(async (q) => {
      await q`UPDATE imported_stores SET activity_tier = ${tier}${services ? q`, biz_model = 'services'` : q``} WHERE domain = ${r.domain}`;
      if (tier !== r.activity_tier)
        await q`INSERT INTO store_edits (domain, editor, field, old_value, new_value)
                VALUES (${r.domain}, ${EDITOR}, 'activity_tier', ${r.activity_tier}, ${`${tier} (Wix ${j.verdict}: ${j.why})`.slice(0, 300)})`;
    }).catch((e) => { writes.failed++; console.log(`!! write failed ${r.domain}: ${e.message}`); });
  });

  console.log(`\nverdicts: ${Object.entries(tally).map(([k, n]) => `${k} ${n}`).join(" · ")}`);
  for (const [mk, t] of Object.entries(byMarket)) console.log(`  ${mk.padEnd(5)} ${Object.entries(t).map(([k, n]) => `${k} ${n}`).join(" · ")}`);
  console.log(`${DRY ? "would write" : "wrote"}: → dormant ${writes.dormant} · back to selling ${writes.selling} · biz_model services ${writes.services} · kept a person's tier ${writes.skippedManual}${writes.failed ? ` · FAILED ${writes.failed}` : ""}`);
} finally {
  await sql.end();
  closeAgents();
}
