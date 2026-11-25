/** confirm-woo-catalogue — the publish path for banked WooCommerce sites, decided by their catalogue.
 *
 *  16.5k live WooCommerce sites in ZA alone sat at published=false, 12.4k of them never checked for
 *  activity at all (2026-11-24). A 100-site sample: 28 have a product catalogue, 21 sell online. This
 *  lane asks each one's public Store API for one page of products (ONE request, the store's own host,
 *  never the Shopify edge, no paid API) and publishes only when lib/woo-confirm.mjs says "store":
 *  >= MIN_BUYABLE buyable, priced products, not a theme demo, priced in the market's currency.
 *
 *  Quote-only catalogues, demos, one-product sites and missing Store APIs stay banked and are stamped
 *  (cms_confirm_at, the shared confirm-lane clock) so they are asked again in 30 days, not every run.
 *  Unreachable sites come back in 7.
 *
 *  NEVER republishes a person's decision: a row whose latest store_edits 'published' edit is a false
 *  (the card-capture fakes, the Springbok clones, Radar confirmations) is excluded from the queue.
 *  Every publish writes its own store_edits row, so the lane is auditable and reversible.
 *
 *    node --env-file=.env.local scripts/confirm-woo-catalogue.mjs --dry [--country ZA] [--limit 200]
 *    node --env-file=.env.local scripts/confirm-woo-catalogue.mjs [--country ZA,KE,NG] [--limit 1500] [--concurrency 6]
 *    node --env-file=.env.local scripts/confirm-woo-catalogue.mjs --domains a.co.za,b.co.za --dry
 */
import postgres from "postgres";
import { judgeCatalogue, isHoldingPage, tidyName } from "./lib/woo-confirm.mjs";
import { extractName, badName, decodeHtml } from "./confirm-other-cms.mjs";

const DRY = process.argv.includes("--dry");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const LIMIT = Number(arg("--limit", 1500));
const CONC = Number(arg("--concurrency", 6));
const PAUSE_MS = Number(arg("--pause", 400));
const COUNTRIES = arg("--country", "ZA,KE,NG").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
const DOMAINS = arg("--domains", null)?.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean) ?? null;
const EDITOR = "lane:confirm-woo-catalogue";
// Same rule as confirm-other-cms: staging/API/dev hosts are never a lead in their own right.
const NON_PROD_HOST = String.raw`^(dev|stg|stage|staging|test|uat|qa|preview|sandbox|api|admin|cms)[-.]|[-.](stg|staging|dev|uat|sandbox)[-.]`;
const UA = "TerrainBot/1.0 (+https://heyterrain.com/about; store check)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One page of the catalogue. Returns { products } or { error, permanent }. */
async function fetchCatalogue(domain) {
  try {
    const r = await fetch(`https://${domain}/wp-json/wc/store/v1/products?per_page=20`, {
      headers: { "User-Agent": UA, Accept: "application/json" }, redirect: "follow", signal: AbortSignal.timeout(15000) });
    // 404 / 401 / 403: the Store API is absent or closed — a fact about the site, not a blip.
    if ([401, 403, 404, 410].includes(r.status)) return { error: `HTTP ${r.status}`, permanent: true };
    if (!r.ok) return { error: `HTTP ${r.status}`, permanent: false };
    if (!(r.headers.get("content-type") ?? "").includes("json")) return { error: "non-JSON", permanent: true };
    const products = await r.json();
    return Array.isArray(products) ? { products } : { error: "not a list", permanent: true };
  } catch (e) {
    return { error: e?.name === "TimeoutError" ? "timeout" : String(e?.cause?.code ?? e?.message ?? e).slice(0, 40), permanent: false };
  }
}

/** The homepage, fetched only for a site that passed the catalogue test: is it open, and what is it called? */
async function homepage(domain) {
  try {
    const r = await fetch(`https://${domain}/`, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(12000) });
    const ct = r.headers.get("content-type") || "";
    if (!r.ok || !/html/i.test(ct)) return null;
    const html = decodeHtml(await r.arrayBuffer(), ct).slice(0, 600_000);
    return { holding: isHoldingPage(html), name: extractName(html) };
  } catch { return null; }
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL not set (--env-file=.env.local)"); process.exit(2); }
  // prepare:false + per-statement timeouts: the pooler drops prepared statements, and a lost reply must
  // not freeze the lane (the 3.6-day hang in woo-catalog-fp, 14→18 Nov).
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3, idle_timeout: 20, connect_timeout: 30,
    connection: { statement_timeout: 120000, lock_timeout: 10000 } });
  try {
    const rows = DOMAINS
      // Named domains skip the queue rules but NOT the human-decision guard.
      ? await sql`SELECT s.domain, s.country, s.name FROM imported_stores s WHERE s.domain = ANY(${DOMAINS}) AND NOT s.published
          AND NOT EXISTS (
            SELECT 1 FROM (SELECT DISTINCT ON (domain) domain, new_value FROM store_edits
                            WHERE field = 'published' ORDER BY domain, edited_at DESC, id DESC) h
             WHERE h.domain = s.domain AND h.new_value LIKE 'false%')`
      : await sql`
        SELECT s.domain, s.country, s.name
          FROM imported_stores s
         WHERE NOT s.published
           AND lower(s.platform) = 'woocommerce'
           AND upper(s.country) = ANY(${COUNTRIES})
           AND (s.live_status IS NULL OR s.live_status NOT IN ('dead', 'migrated'))
           AND s.domain NOT LIKE 'www.%'
           AND s.domain !~* ${NON_PROD_HOST}
           AND (s.cms_confirm_at IS NULL OR s.cms_confirm_at < now() -
                CASE WHEN s.live_status = 'active' THEN interval '30 days' ELSE interval '7 days' END)
           -- A person's unpublish is final for this lane (see header).
           AND NOT EXISTS (
             SELECT 1 FROM (SELECT DISTINCT ON (domain) domain, new_value FROM store_edits
                             WHERE field = 'published' ORDER BY domain, edited_at DESC, id DESC) h
              WHERE h.domain = s.domain AND h.new_value LIKE 'false%')
         ORDER BY s.cms_confirm_at NULLS FIRST, s.product_count DESC NULLS LAST, s.domain
         LIMIT ${LIMIT}`;

    console.log(`Checking ${rows.length.toLocaleString()} banked Woo site(s) in ${DOMAINS ? "named domains" : COUNTRIES.join(",")} ` +
      `at concurrency ${CONC}${DRY ? " [DRY — no writes]" : ""}…`);
    const tally = {}; const shown = []; let published = 0, i = 0;

    const worker = async () => {
      while (i < rows.length) {
        const r = rows[i++];
        const got = await fetchCatalogue(r.domain);
        let verdict, detail = "";
        if (got.error) {
          verdict = got.permanent ? "no_store_api" : "unreachable";
          detail = got.error;
        } else {
          const j = judgeCatalogue(got.products, r.country);
          verdict = j.verdict;
          detail = `${j.buyable}/${j.products} buyable${j.currency ? ` in ${j.currency}` : ""}${j.placeholder ? `, ${j.placeholder} placeholder` : ""}`;
        }

        let name = null;
        if (verdict === "store") {
          const home = await homepage(r.domain);
          if (!home) { verdict = "home_unreachable"; detail += ", homepage did not load"; }
          else if (home.holding) { verdict = "holding_page"; detail += ", coming-soon/maintenance page"; }
          else {
            for (const cand of [r.name, home.name]) {
              const t = tidyName(cand);
              if (t && !badName(t, r.domain)) { name = t; break; }
            }
            if (!name) { verdict = "no_name"; detail += ", no usable name"; }
          }
        }
        tally[verdict] = (tally[verdict] ?? 0) + 1;
        if (verdict === "store") published++;
        if (verdict === "store" || (DRY && shown.length < 15)) shown.push(`${verdict.padEnd(14)} ${r.domain.padEnd(36)} ${detail}${verdict === "store" ? `  "${name}"` : ""}`);

        if (!DRY) {
          // Liveness belongs to verify-liveness (memory: liveness-column-ownership). Only a publish
          // asserts it, exactly as confirm-other-cms does; every other outcome just stamps the clock.
          if (verdict === "store") {
            await sql.begin(async (q) => {
              // A buyable catalogue outranks an older homepage-based 'not_a_store' / empty activity label:
              // lib/browse.ts hides not_a_store from the lead list, so leaving it would publish a store
              // nobody can see (10 of the first 26 publishes, 2026-11-25). 'active' = selling products,
              // no order evidence; selling/dormant labels from the Woo probe are kept.
              await q`UPDATE imported_stores SET published = true, name = ${name}, live_status = 'active',
                        live_checked_at = now(), cms_confirm_at = now(),
                        activity_tier = CASE WHEN activity_tier IS NULL OR activity_tier = 'not_a_store' THEN 'active' ELSE activity_tier END
                      WHERE domain = ${r.domain} AND NOT published`;
              await q`INSERT INTO store_edits (domain, editor, field, old_value, new_value)
                      VALUES (${r.domain}, ${EDITOR}, 'published', 'false', ${`true (Woo catalogue: ${detail})`})`;
            }).catch((e) => console.log(`!! write failed ${r.domain}: ${e.message}`));
          } else {
            await sql`UPDATE imported_stores SET cms_confirm_at = now() WHERE domain = ${r.domain}`.catch((e) => console.log(`!! stamp failed ${r.domain}: ${e.message}`));
          }
        }
        await sleep(PAUSE_MS);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONC, rows.length) }, worker));

    console.log(shown.join("\n"));
    console.log(`\nDone${DRY ? " [DRY]" : ""}. ${rows.length} checked · ${published} ${DRY ? "would be " : ""}published · ` +
      Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · "));
  } finally { await sql.end({ timeout: 5 }); }
}

main().catch((e) => { console.error("failed:", e.message); process.exit(1); });
