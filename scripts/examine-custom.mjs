/** examine-custom — figure out what the 'custom' (unfingerprinted) CrUX-discovered stores actually
 *  run, so we learn which platforms we're NOT yet detecting and should add to ingest-ranked.
 *
 *  For a sample of source='crux-ranked' platform='custom' stores it re-fetches the homepage and reads:
 *    • <meta name="generator"> (many CMSs self-declare here),
 *    • Server / X-Powered-By response headers,
 *    • a BROAD signature set covering platforms ingest-ranked does NOT cover (Salesforce Commerce
 *      Cloud, SAP Hybris, VTEX, Shoplazza/Shopline, Spree, Framer, GoDaddy, Weebly/Square, Drupal/
 *      Joomla commerce, regional African tools like Bumpa/Selar/Payhip, …),
 *    • failing all that, the JS framework (Next/Nuxt/React/Vue/…) → a genuinely headless/bespoke build.
 *  Read-only: it only tallies + prints examples. Gentle on the shared IP (low concurrency, pause).
 *
 *    node --env-file=.env.local scripts/examine-custom.mjs [--country ZA] [--limit 200] [--concurrency 2]
 */
import postgres from "postgres";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const COUNTRY = arg("--country", null);
const LIMIT = parseInt(arg("--limit", "200"), 10);
const CONC = parseInt(arg("--concurrency", "2"), 10);
const PAUSE_MS = parseInt(arg("--pause", "350"), 10);
// --apply relabels a custom store to its real platform when we now recognise it (custom → X-Cart /
// VTEX / Salesforce Commerce Cloud / …). Only ecommerce-platform matches; headless/noise stay custom.
const APPLY = process.argv.includes("--apply");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Platforms we do NOT currently fingerprint in ingest-ranked — the whole point is to surface these.
const UNCOVERED = [
  { name: "Salesforce Commerce Cloud", sig: ["demandware", "dwstatic", "/on/demandware", "dw.ac", "dwcdn.net", "sites-site-"] },
  { name: "SAP Hybris", sig: ["hybris", "yacceleratorstorefront", "/_ui/responsive"] },
  { name: "VTEX", sig: ["vtex", "vteximg.com", "vtexassets.com", "vtexcommercestable"] },
  { name: "Shoplazza", sig: ["shoplazza", "myshoplaza"] },
  { name: "Shopline", sig: ["myshopline", "shoplineapp", "shopline.com"] },
  { name: "Spree", sig: ["data-spree", "/spree/", "spree_"] },
  { name: "Saleor", sig: ["saleor"] },
  { name: "Medusa", sig: ["medusajs", "medusa-"] },
  { name: "Framer", sig: ["framerusercontent", "data-framer-", "framer.com"] },
  { name: "GoDaddy Website Builder", sig: ["img1.wsimg.com", "/ds/", "godaddy"] },
  { name: "Weebly/Square Online", sig: ["weebly", "editmysite", "square-web", "squareup.com"] },
  { name: "Jumpseller", sig: ["jumpseller"] },
  { name: "Tiendanube/Nuvemshop", sig: ["tiendanube", "nuvemshop"] },
  { name: "CS-Cart", sig: ["cs-cart", "cscart"] },
  { name: "nopCommerce", sig: ["nopcommerce"] },
  { name: "Volusion", sig: ["volusion"] },
  { name: "Shift4Shop/3dcart", sig: ["3dcart", "shift4shop"] },
  { name: "Zen Cart / osCommerce", sig: ["zencart", "oscommerce"] },
  { name: "X-Cart", sig: ["x-cart", "xcart"] },
  { name: "Drupal Commerce", sig: ["drupal-", "sites/default/files", "data-drupal"] },
  { name: "Joomla (VirtueMart/HikaShop)", sig: ["com_virtuemart", "com_hikashop", "/media/jui/"] },
  { name: "Bumpa", sig: ["bumpa", "getbumpa"] },           // Nigeria
  { name: "Selar", sig: ["selar.co", "selar.com"] },        // Africa creator commerce
  { name: "Payhip", sig: ["payhip"] },
  { name: "Gumroad", sig: ["gumroad"] },
  { name: "Catlog", sig: ["catlog.shop", "catlog.ng"] },    // Nigeria
  { name: "Square Space store", sig: ["squarespace"] },     // (we only detect SS loosely — confirm)
  { name: "Ecwid (on-site)", sig: ["ecwid"] },
];
// Framework-only → genuinely headless/bespoke (no platform tell in the HTML).
const FRAMEWORKS = [
  { name: "Next.js", sig: ["__next_data__", "/_next/static"] },
  { name: "Nuxt", sig: ["__nuxt__", "/_nuxt/"] },
  { name: "Gatsby", sig: ["___gatsby", "gatsby-"] },
  { name: "Remix", sig: ["__remixcontext", "data-remix"] },
  { name: "Angular", sig: ["ng-version", "ng-app"] },
  { name: "Vue", sig: ["data-v-", "__vue__", "vue.runtime"] },
  { name: "React (generic)", sig: ["data-reactroot", "react-dom", "_reactrootcontainer"] },
];

async function fetchStore(domain) {
  for (const host of [domain, `www.${domain}`]) {
    try {
      const res = await fetch(`https://${host}/`, { headers: { "User-Agent": UA, Accept: "text/html,*/*" }, signal: AbortSignal.timeout(14000), redirect: "follow" });
      if (res.status === 429 || res.status >= 500) return { retriable: true };
      if (!res.ok) continue;
      const html = (await res.text().catch(() => "")).slice(0, 900_000);
      return { html, server: res.headers.get("server") || "", xpb: res.headers.get("x-powered-by") || "" };
    } catch (e) { if (e.name === "TimeoutError") return { dead: true }; }
  }
  return { dead: true };
}

function identify({ html, server, xpb }) {
  const hay = html.toLowerCase();
  const gen = (/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)/i.exec(html) || [])[1] || "";
  for (const p of UNCOVERED) if (p.sig.some((s) => hay.includes(s))) return { kind: "uncovered-platform", label: p.name, gen };
  // generator / headers can name a platform even without an HTML body signature
  const hdr = `${gen} ${server} ${xpb}`.toLowerCase();
  const fromHdr = [
    ["wordpress", "WordPress (non-Woo)"], ["drupal", "Drupal"], ["joomla", "Joomla"], ["wix", "Wix"],
    ["squarespace", "Squarespace"], ["shopify", "Shopify"], ["ghost", "Ghost"], ["webflow", "Webflow"],
    ["duda", "Duda"], ["hubspot", "HubSpot CMS"], ["bigcommerce", "BigCommerce"], ["prestashop", "PrestaShop"],
    ["contao", "Contao"], ["typo3", "TYPO3"], ["concrete", "Concrete CMS"], ["sitecore", "Sitecore"],
  ].find(([k]) => hdr.includes(k));
  if (fromHdr) return { kind: "named-by-header", label: fromHdr[1], gen };
  for (const f of FRAMEWORKS) if (f.sig.some((s) => hay.includes(s))) return { kind: "headless", label: f.name, gen };
  return { kind: "unidentified", label: "unidentified", gen };
}

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: Math.min(CONC + 1, 4), idle_timeout: 20 });
try {
  const rows = await sql`SELECT domain FROM imported_stores
    WHERE source = ${"crux-ranked"} AND platform = ${"custom"} ${COUNTRY ? sql`AND country = ${COUNTRY.toUpperCase()}` : sql``}
    ORDER BY crux_rank NULLS LAST, random() LIMIT ${LIMIT}`;
  console.log(`examine-custom: ${rows.length} custom stores${COUNTRY ? ` (${COUNTRY})` : ""}, conc ${CONC}\n`);

  const tally = new Map(); const examples = new Map(); const gens = new Map();
  let i = 0, done = 0, dead = 0, relabeled = 0;
  async function worker() {
    while (i < rows.length) {
      const { domain } = rows[i++];
      const r = await fetchStore(domain);
      if (r.retriable) { await sleep(PAUSE_MS); continue; }
      if (r.dead) { dead++; await sleep(PAUSE_MS); continue; }
      const id = identify(r);
      if (APPLY && id.kind === "uncovered-platform") {
        await sql`UPDATE imported_stores SET platform = ${id.label}
          WHERE domain = ${domain} AND source = ${"crux-ranked"} AND platform = ${"custom"}`.catch(() => {});
        relabeled++;
      }
      const key = `${id.label}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
      if (!examples.has(key)) examples.set(key, []);
      if (examples.get(key).length < 4) examples.get(key).push(domain);
      if (id.gen) gens.set(id.gen.slice(0, 40), (gens.get(id.gen.slice(0, 40)) ?? 0) + 1);
      if (++done % 50 === 0) console.log(`  …${done}/${rows.length}`);
      await sleep(PAUSE_MS);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  console.log(`\n=== what the 'custom' stores actually run (${done} reached, ${dead} dead)${APPLY ? ` · relabeled ${relabeled} custom → real platform` : ""} ===`);
  for (const [k, n] of [...tally.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(n).padStart(4)}  ${k.padEnd(28)} e.g. ${(examples.get(k) || []).join(", ")}`);
  console.log(`\n=== top <meta generator> values seen ===`);
  for (const [k, n] of [...gens.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${String(n).padStart(4)}  ${k}`);
} finally { await sql.end(); }
