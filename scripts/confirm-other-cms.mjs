/** confirm-other-cms — the publish path for banked stores on dedicated commerce platforms.
 *
 *  Stores reach us already labelled with a commerce platform: reconcile-probed (HTTP), detect-builders
 *  and the CT tailer (DNS fingerprint, scripts/lib/hosted-platforms.json). They land published=false.
 *  This is the step that confirms and publishes them, for DEDICATED commerce platforms only: being on
 *  Cafe24 / YouCan / colorme / PrestaShop is itself strong evidence of a store. General site builders
 *  (Wix, Squarespace, Webflow, GoDaddy, Duda, Jimdo, SITE123, …) leak cart markup on brochure sites,
 *  so they go through the stricter builder-promote lane instead, never this one.
 *
 *  It fetches each banked store's homepage ONCE (the store's own host, never the Shopify edge, no paid
 *  API) and:
 *    • reads a name (og:site_name / <title>) when we don't have a good one, decoding the page in its
 *      own charset (EUC-JP / Shift_JIS Japanese stores came out as mojibake under plain UTF-8),
 *    • marks liveness (reachable html → active),
 *    • PUBLISHES only when the page shows a real commerce action (cart / checkout / price / product
 *      markup, including each Japanese platform's own cart and product URLs) AND it has a real name.
 *  With the cms_confirm_at column (--migrate), every attempt is stamped so a row that failed isn't
 *  re-fetched every 6 hours forever: unreachable rows come back after 7 days, live no-cart rows after
 *  30. Without the column it behaves as before.
 *
 *  Hosted platforms put thousands of stores behind ONE edge, so at most PER_PLAT fetches run against a
 *  platform at a time and each run takes at most --per-platform rows from any one platform.
 *
 *    node --env-file=.env.local scripts/confirm-other-cms.mjs --migrate        # add cms_confirm_at (once)
 *    node --env-file=.env.local scripts/confirm-other-cms.mjs --dry            # preview, no writes
 *    node --env-file=.env.local scripts/confirm-other-cms.mjs [--country ZA,KE] [--limit 8000] [--concurrency 8] [--per-platform 1500]
 *  Default scope is worldwide, focus markets (Africa + JP) first; --country narrows it.
 */
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureColumns } from "./lib/ensure-schema.mjs";

const DRY = process.argv.includes("--dry");
const MIGRATE = process.argv.includes("--migrate");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const LIMIT = Number(arg("--limit", 4000));
const CONC = Number(arg("--concurrency", 8));
const PER_PLATFORM = Number(arg("--per-platform", 1500));
const PER_PLAT = 2;                                  // in-flight fetches per platform edge
const FOCUS = "AO,BW,CI,CM,DZ,EG,ET,GH,KE,LS,LY,MA,MU,MW,MZ,NA,NG,RW,SN,SO,SZ,TN,TZ,UG,ZA,ZM,ZW,JP".split(",");
const cArg = arg("--country", null);
const pArg = arg("--platform", null);   // narrow to platforms (comma list, case-insensitive), for testing
const countries = cArg ? cArg.split(",").map((c) => c.trim().toUpperCase()) : null;   // null = worldwide

// Self-hosted / not-DNS-fingerprintable dedicated platforms (HTTP-labelled by reconcile-probed).
const SELF_HOSTED = ["prestashop", "magento", "opencart", "shopware", "ec-cube", "oscommerce", "zen cart", "virtuemart"];
// Plus every `commerce` row of the shared hosted-platform table. Shopify has its own lanes; Selar is
// path-based (selar.com/<shop>) and has its own sitemap ingester.
const NOT_HERE = new Set(["shopify", "selar"]);
const HERE = dirname(fileURLToPath(import.meta.url));
const HOSTED = JSON.parse(readFileSync(join(HERE, "lib", "hosted-platforms.json"), "utf8")).platforms
  .filter((p) => p.kind === "commerce").map((p) => p.name.toLowerCase()).filter((n) => !NOT_HERE.has(n));
export const STORE_CMS = [...new Set([...SELF_HOSTED, ...HOSTED])];
// Sources whose platform/country labels aren't evidence. crux-ranked stamps the CrUX market as the
// country and its platform tags are vendor guesses (2026-11-13: balenciaga.com "JP", cartier.com "MA",
// builtwith.com "Salesforce Commerce Cloud"); publishing them would put global brands into African
// dashboards. They stay banked until crux-country.mjs re-derives their country.
const UNTRUSTED_SOURCES = ["crux-ranked"];
// …unless BOTH labels now carry evidence: the country (crux-country.mjs or a store-level lane) AND the
// platform, via the DNS fingerprint (detect-builders/CT set hosting_provider = platform). ingest-ranked's
// own homepage platform guesses are not evidence (11-13: lavanguardia.com "VTEX", train-times.net
// "Shopware", charleskeith.com "SFCC").
const EVIDENCED_COUNTRY = ["cctld", "crux-home", "shop_meta", "shopify_meta", "storefront", "payment_geo", "manual"];
// Staging / API / dev hosts of real stores — never a lead in their own right.
const NON_PROD_HOST = String.raw`^(dev|stg|stage|staging|test|uat|qa|preview|sandbox|api|admin|cms)[-.]|[-.](stg|staging|dev|uat|sandbox)[-.]`;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const clean = (d) => (d || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");

// Decode in the page's own charset: header first, then <meta charset>, else UTF-8.
export function decodeHtml(buf, contentType = "") {
  const bytes = new Uint8Array(buf);
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  let cs = (contentType.match(/charset=["']?([\w-]+)/i)?.[1]
    || head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] || "utf-8").toLowerCase();
  if (cs === "x-sjis" || cs === "sjis") cs = "shift_jis";
  try { return new TextDecoder(cs).decode(bytes); } catch { return new TextDecoder("utf-8").decode(bytes); }
}

async function getHtml(domain, ms = 12000) {
  try {
    const r = await fetch(`https://${clean(domain)}/`, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(ms) });
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") || "";
    if (!/html/i.test(ct)) return null;
    return decodeHtml(await r.arrayBuffer(), ct).slice(0, 1_200_000);
  } catch { return null; }
}

const decode = (s) => s.replace(/&amp;/g, "&").replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d));
const PLACEHOLDER = new Set(["mysite", "home", "homepage", "website", "untitled", "index", "welcome", "new page", "store", "shop", "loading", "my site"]);
export function extractName(html) {
  const m = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
  let name = m?.[1] || (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "");
  name = decode(name).replace(/\s+/g, " ").trim();
  if (name.length > 24) name = name.split(/\s[|｜–—·]\s?|\s?[|｜]\s/)[0].trim();   // "Brand | tagline" → "Brand"
  return name.length >= 2 && name.length <= 80 ? name : null;
}
// reject junk names: placeholders, mojibake, or the domain itself (Wix default <title> is often the bare domain)
export function badName(name, domain) {
  if (!name) return true;
  const t = name.toLowerCase().trim();
  if (PLACEHOLDER.has(t)) return true;
  if (/�|â€|Ã[\x80-\xBF]/.test(name)) return true;   // decoding failed somewhere upstream
  const dom = clean(domain).replace(/^www\./, "");
  if (t === dom || t.replace(/\s/g, "") === dom.replace(/\./g, "")) return true;
  if (/^[a-z0-9.-]+\.(co\.za|com|net|org|africa|ng|ke|eg|gh|io|shop|store)$/i.test(t)) return true;  // name is a domain
  return false;
}
// STRICT: a real storefront exposes an actual commerce action (add-to-cart button/text, a cart/checkout
// URL, product price markup). Platform *presence* is NOT enough. The Japanese platforms use their own
// URL shapes (tested 2026-11-13: these are what the 4/8 colorme, 4/10 makeshop and 2/6 shopserve
// stores the generic check missed carry): colorme ?pid= product links / ?mode=cart, makeshop
// /shop/basket.html + /shopdetail/, shopserve cartN.shopserve.jp, plus Japanese cart wording.
export const ECOM = new RegExp([
  String.raw`add[-_\s]?to[-_\s]?(?:cart|bag|basket)`, String.raw`data-hook=["'][^"']*add-to-cart`,
  String.raw`sqs-add-to-cart-button`, String.raw`name=["']add-to-cart["']`, String.raw`[?&]add-to-cart=\d`,
  String.raw`href=["'][^"']*\/(?:checkout|cart)(?:[\/?"']|$)`, String.raw`og:type["'][^>]*content=["']product`,
  String.raw`itemprop=["']price["']`, String.raw`property=["']product:price`,
  String.raw`href=["'][^"']*[?&]pid=\d{5,}`, String.raw`[?&]mode=cart\b`,
  String.raw`\/shop\/basket\.html`, String.raw`href=["'][^"']*\/shopdetail\/\d`,
  String.raw`cart\d*\.shopserve\.jp`, `カートに入れる|カートを見る|カートをみる|買い物かご|ショッピングカート|カゴに入れる`,
].join("|"), "i");

async function main() {
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL not set (--env-file=.env.local)"); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: CONC + 1 });
  try {
    await sql`SET statement_timeout = 300000`;
    if (MIGRATE) {
      await sql`SET lock_timeout = 5000`;
      const n = await ensureColumns(sql, "imported_stores", { cms_confirm_at: "TIMESTAMPTZ" });
      console.log(n ? "added imported_stores.cms_confirm_at" : "cms_confirm_at already present");
      return;
    }
    const stamped = (await sql`SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'imported_stores' AND column_name = 'cms_confirm_at'`).length > 0;
    const retry = stamped
      ? sql`AND (cms_confirm_at IS NULL OR cms_confirm_at < now() - CASE WHEN live_status = 'active' THEN interval '30 days' ELSE interval '7 days' END)`
      : sql``;
    // Rank within each platform so one platform's burst (e.g. a day of CT finds on one edge) can't
    // take the whole run. Focus markets, then named rows, then newest first.
    const rows = await sql`
      SELECT domain, platform, country, name FROM (
        SELECT domain, platform, country, name, discovered_at,
               upper(coalesce(country, '')) = ANY(${FOCUS}) AS focus,
               row_number() OVER (PARTITION BY lower(platform)
                 ORDER BY upper(coalesce(country, '')) = ANY(${FOCUS}) DESC, (name IS NOT NULL) DESC, discovered_at DESC NULLS LAST) AS rn
          FROM imported_stores
         WHERE NOT published AND lower(platform) = ANY(${STORE_CMS})
           AND (live_status IS NULL OR live_status <> 'dead')
           AND activity_tier IS DISTINCT FROM 'not_a_store'
           AND (coalesce(source, '') <> ALL(${UNTRUSTED_SOURCES})
                OR (country_source = ANY(${EVIDENCED_COUNTRY}) AND hosting_provider = platform))
           AND domain !~* ${NON_PROD_HOST}
           ${pArg ? sql`AND lower(platform) = ANY(${pArg.toLowerCase().split(",")})` : sql``}
           ${countries ? sql`AND upper(country) = ANY(${countries})` : sql``}
           ${retry}
      ) t WHERE rn <= ${PER_PLATFORM}
      ORDER BY focus DESC, (name IS NOT NULL) DESC, discovered_at DESC NULLS LAST
      LIMIT ${LIMIT}`;
    if (!rows.length) { console.log("Nothing banked to confirm."); return; }
    const plats = {};
    for (const r of rows) plats[r.platform] = (plats[r.platform] || 0) + 1;
    console.log(`Confirming ${rows.length} banked store(s) at concurrency ${CONC} (≤${PER_PLAT} per platform)${DRY ? " [DRY]" : ""}${stamped ? "" : " · no cms_confirm_at yet (run --migrate): failures re-queue every run"}`);
    console.log("queue:", Object.entries(plats).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" "), "\n");

    let checked = 0, unreachable = 0, named = 0, published = 0, noEcom = 0, shown = 0;
    const byCms = {}, inFlight = {};
    const pending = rows.slice();
    // Next row whose platform has a free slot; null when every remaining row's platform is busy.
    const take = () => {
      const i = pending.findIndex((r) => (inFlight[r.platform] || 0) < PER_PLAT);
      return i < 0 ? null : pending.splice(i, 1)[0];
    };
    async function worker() {
      while (pending.length) {
        const r = take();
        if (!r) { await new Promise((res) => setTimeout(res, 200)); continue; }
        inFlight[r.platform] = (inFlight[r.platform] || 0) + 1;
        try {
          checked++;
          const h = await getHtml(r.domain);
          if (!h) {
            unreachable++;
            if (!DRY && stamped) await sql`UPDATE imported_stores SET cms_confirm_at = now() WHERE domain = ${r.domain}`.catch(() => {});
            continue;
          }
          const existing = r.name && r.name.trim() ? r.name.trim() : null;
          const existingGood = existing && !badName(existing, r.domain);
          const extracted = existingGood ? existing : extractName(h);   // re-extract when the stored name is a domain/placeholder
          const name = extracted && !badName(extracted, r.domain) ? extracted : null;   // null ⇒ don't publish/write
          const isStore = ECOM.test(h);
          const canPublish = isStore && !!name;
          if (canPublish) { published++; byCms[r.platform] = (byCms[r.platform] || 0) + 1; }
          else if (!isStore) noEcom++;
          if (name && name !== existing) named++;   // counts re-extractions over a bad/empty stored name
          if (DRY) {
            if (canPublish && shown < 24) { shown++; console.log(`✓ PUBLISH  ${clean(r.domain)} [${r.platform}/${r.country ?? "—"}]  "${name}"`); }
          } else {
            await sql`UPDATE imported_stores SET
              name = ${name ?? sql`name`},
              live_status = 'active', live_checked_at = now(),
              published = ${canPublish ? true : sql`published`}
              ${stamped ? sql`, cms_confirm_at = now()` : sql``}
            WHERE domain = ${r.domain}`.catch(() => {});
          }
        } finally { inFlight[r.platform]--; }
        if (checked % 100 === 0 || checked === rows.length) console.log(`— ${checked}/${rows.length}  (${published} publishable, ${named} newly named, ${noEcom} not-a-store, ${unreachable} unreachable)`);
      }
    }
    await Promise.all(Array.from({ length: CONC }, worker));
    console.log(`\nDone${DRY ? " [DRY — no writes]" : ""}. ${checked} checked · ${published} ${DRY ? "would be " : ""}published · ${named} newly named · ${noEcom} live-but-not-a-store (left banked) · ${unreachable} unreachable.`);
    console.log("published by CMS:", Object.entries(byCms).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" ") || "(none)");
  } finally { await sql.end(); }
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error("failed:", e.message); process.exit(1); });
