/** confirm-other-cms — surface the banked non-Shopify/Woo "Other CMS" backlog.
 *
 *  reconcile-probed stamps a CMS on probed stores but only auto-publishes Shopify/Woo; Wix/Squarespace/
 *  Magento/PrestaShop/Webflow/OpenCart/Odoo/Ecwid/… are banked (platform set, published=false). Nothing
 *  then confirms + publishes them, so "Other CMS" reads ~2% even though the stores exist.
 *
 *  This fetches each banked store's homepage ONCE (their own server — no Shopify-edge rate budget, no
 *  paid API), and:
 *    • grabs a name (og:site_name / <title>) when we don't have one,
 *    • marks liveness (reachable html → active),
 *    • PUBLISHES only when it's a confirmed LIVE eCOMMERCE store (cart/checkout signal) AND named —
 *      honouring the published=false-until-confirmed discipline (brochure/blog sites stay banked).
 *
 *    node --env-file=.env.local scripts/confirm-other-cms.mjs --dry            # preview, no writes
 *    node --env-file=.env.local scripts/confirm-other-cms.mjs [--country ZA] [--limit 3000] [--concurrency 8]
 */
import postgres from "postgres";

const DRY = process.argv.includes("--dry");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const LIMIT = Number(arg("--limit", 4000));
const CONC = Number(arg("--concurrency", 8));
const MARKETS = "AO,BW,CI,CM,DZ,EG,ET,GH,KE,LS,LY,MA,MU,MW,MZ,NA,NG,RW,SN,SO,SZ,TN,TZ,UG,ZA,ZM,ZW,JP".split(",");
const cArg = arg("--country", null);
const countries = cArg ? cArg.split(",").map((c) => c.trim().toUpperCase()) : MARKETS;
// DEDICATED commerce platforms only — being on these is itself strong store confirmation (unlike Wix/
// Squarespace/Webflow general site-builders, whose templates leak cart markup on non-store sites and
// over-publish NGOs/agencies/clinics). Those general builders need rigorous catalogue verification we
// don't do here, so they stay banked.
const STORE_CMS = ["prestashop", "magento", "opencart", "ecwid", "bigcommerce", "shopware", "shopstar", "base"];

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const clean = (d) => (d || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");

async function getHtml(domain, ms = 12000) {
  try {
    const r = await fetch(`https://${clean(domain)}/`, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(ms) });
    if (!r.ok) return null;
    if (!/html/i.test(r.headers.get("content-type") || "")) return null;
    return (await r.text()).slice(0, 1_200_000);
  } catch { return null; }
}

const decode = (s) => s.replace(/&amp;/g, "&").replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d));
const PLACEHOLDER = new Set(["mysite", "home", "homepage", "website", "untitled", "index", "welcome", "new page", "store", "shop", "loading", "my site"]);
function extractName(html) {
  let m = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
  let name = m?.[1] || (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "");
  name = decode(name).replace(/\s+/g, " ").trim();
  if (name.length > 24) name = name.split(/\s[|–—·]\s/)[0].trim();   // "Brand | tagline" → "Brand"
  return name.length >= 2 && name.length <= 80 ? name : null;
}
// reject junk names: placeholders, or the domain itself (Wix default <title> is often the bare domain)
function badName(name, domain) {
  if (!name) return true;
  const t = name.toLowerCase().trim();
  if (PLACEHOLDER.has(t)) return true;
  const dom = clean(domain).replace(/^www\./, "");
  if (t === dom || t.replace(/\s/g, "") === dom.replace(/\./g, "")) return true;
  if (/^[a-z0-9.-]+\.(co\.za|com|net|org|africa|ng|ke|eg|gh|io|shop|store)$/i.test(t)) return true;  // name is a domain
  return false;
}
// STRICT: a real storefront exposes an actual commerce action (add-to-cart button/text, a cart/checkout
// URL, product price markup). Platform *presence* (woocommerce/wixstores strings) is NOT enough — Wix
// injects cart JS on brochure/church/clinic sites too, which over-published non-stores.
const ECOM = /add[-_\s]?to[-_\s]?(?:cart|bag|basket)|data-hook=["'][^"']*add-to-cart|sqs-add-to-cart-button|name=["']add-to-cart["']|[?&]add-to-cart=\d|href=["'][^"']*\/(?:checkout|cart)(?:[\/?"']|$)|og:type["'][^>]*content=["']product|itemprop=["']price["']|property=["']product:price/i;

async function main() {
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL not set (--env-file=.env.local)"); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: CONC + 1 });
  try {
    const rows = await sql`
      SELECT domain, platform, country, name FROM imported_stores
      WHERE NOT published AND lower(platform) = ANY(${STORE_CMS})
        AND (live_status IS NULL OR live_status <> 'dead')
        AND UPPER(country) = ANY(${countries})
      ORDER BY (name IS NOT NULL) DESC, discovered_at DESC NULLS LAST
      LIMIT ${LIMIT}`;
    if (!rows.length) { console.log("Nothing banked to confirm."); return; }
    console.log(`Confirming ${rows.length} banked store(s) at concurrency ${CONC}${DRY ? " [DRY]" : ""}…\n`);

    let idx = 0, checked = 0, unreachable = 0, named = 0, published = 0, noEcom = 0, shown = 0;
    const byCms = {};
    async function worker() {
      while (idx < rows.length) {
        const r = rows[idx++]; checked++;
        const h = await getHtml(r.domain);
        if (!h) { unreachable++; continue; }
        const existing = r.name && r.name.trim() ? r.name.trim() : null;
        const existingGood = existing && !badName(existing, r.domain);
        const extracted = existingGood ? existing : extractName(h);   // re-extract when the stored name is a domain/placeholder
        const name = extracted && !badName(extracted, r.domain) ? extracted : null;   // null ⇒ don't publish/write
        const isStore = ECOM.test(h);
        const canPublish = isStore && !!name;
        if (canPublish) { published++; byCms[r.platform] = (byCms[r.platform] || 0) + 1; }
        else if (!isStore) noEcom++;
        if (name && !existing) named++;
        if (DRY) {
          if (canPublish && shown < 18) { shown++; console.log(`✓ PUBLISH  ${clean(r.domain)} [${r.platform}/${r.country}]  "${name}"`); }
        } else {
          await sql`UPDATE imported_stores SET
            name = COALESCE(NULLIF(name,''), ${name}),
            live_status = 'active', live_checked_at = now(),
            published = ${canPublish ? true : sql`published`}
          WHERE domain = ${clean(r.domain)}`.catch(() => {});
        }
        if (checked % 50 === 0 || checked === rows.length) console.log(`— ${checked}/${rows.length}  (${published} publishable, ${named} newly named, ${noEcom} not-a-store, ${unreachable} unreachable)`);
      }
    }
    await Promise.all(Array.from({ length: CONC }, worker));
    console.log(`\nDone${DRY ? " [DRY — no writes]" : ""}. ${checked} checked · ${published} ${DRY ? "would be " : ""}published · ${named} newly named · ${noEcom} live-but-not-a-store (left banked) · ${unreachable} unreachable.`);
    console.log("published by CMS:", Object.entries(byCms).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" ") || "(none)");
  } finally { await sql.end(); }
}
main().catch((e) => { console.error("failed:", e.message); process.exit(1); });
