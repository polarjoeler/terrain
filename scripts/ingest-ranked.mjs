/** ingest-ranked — discover untracked ZA (etc.) stores from the CrUX traffic ranks.
 *
 *  CrUX publishes the most-visited origins per country (zakird/crux-top-lists). Most of our discovery
 *  is Shopify/Woo-centric, so the high-traffic HEAD of a market — where the big retailers live, often
 *  on BESPOKE platforms (takealot, studio-88, identity, adendorff) — is invisible to us. This pulls
 *  the ranked domains we DON'T already track, fetches each homepage once, and classifies:
 *    • a known ecommerce platform (Shopify/Woo/Magento/…) → store, platform = that;
 *    • a mixed site/store builder (Wix/Squarespace/Webflow) → store only if it shows cart/checkout;
 *    • no known platform but real store markers → platform = 'custom' (the bespoke head);
 *    • otherwise → not_store (blog/corporate/news) — logged, not imported.
 *  Stores land published=false (unconfirmed, per the bulk-import rule) with their crux_rank, for the
 *  normal confirm/enrich lanes to pick up. Non-stores + dead are logged so re-runs skip them.
 *
 *  Own-domain fetches across varied hosts (not the Shopify edge), but still one residential IP — so it
 *  runs gently (low concurrency, pause, 429 backoff). Resumable via ranked_ingest_log.
 *
 *    node --env-file=.env.local scripts/ingest-ranked.mjs [--country ZA] [--max-rank 10000]
 *        [--limit 500] [--concurrency 3] [--pause 300] [--dry-run]
 */
import postgres from "postgres";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const COUNTRY = arg("--country", "ZA").toUpperCase();
const MAX_RANK = parseInt(arg("--max-rank", "10000"), 10);     // the valuable head; 50000+ is mostly tail/noise
const LIMIT = parseInt(arg("--limit", "500"), 10);
const CONC = parseInt(arg("--concurrency", "3"), 10);
const PAUSE_MS = parseInt(arg("--pause", "300"), 10);
const MONTH = arg("--month", null);                            // default: latest available
const DRY = process.argv.includes("--dry-run");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (d) => d.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");

/* ---- platform detection (from homepage HTML) ------------------------------ */
// Ordered: first match wins. 'native' = store by platform; 'mixed' = needs store markers.
const PLATFORMS = [
  { name: "Shopify",        kind: "native", sig: ["cdn.shopify.com", "cdn/shop/", "myshopify.com", "shopify.theme", "x-shopify"] },
  { name: "WooCommerce",    kind: "native", sig: ["woocommerce", "wp-content/plugins/woocommerce", "wc-block"] },
  // NB: avoid "mage/" — it is a substring of "image/" and matches almost every site.
  { name: "Magento",        kind: "native", sig: ["data-mage-init", "mage-cache-storage", "/static/version", "/frontend/magento", "magento_", "mage/cookies"] },
  { name: "Adobe Commerce", kind: "native", sig: ["adobe commerce", "magento_commerce"] },
  { name: "BigCommerce",    kind: "native", sig: ["cdn11.bigcommerce.com", "bigcommerce.com/s-", "stencil-utils"] },
  { name: "PrestaShop",     kind: "native", sig: ["prestashop", "/modules/ps_"] },
  { name: "OpenCart",       kind: "native", sig: ["catalog/view/theme", "route=product&", "index.php?route="] },
  { name: "Shopware",       kind: "native", sig: ["shopware", "cms-element-"] },
  { name: "Ecwid",          kind: "native", sig: ["ecwid", "app.ecwid.com", "ecwid_script"] },
  { name: "Big Cartel",     kind: "native", sig: ["bigcartel.com", "data-bc-"] },
  { name: "ShopStar",       kind: "native", sig: ["shopstar.co.za", "_tillyoudrop_session"] },
  { name: "Wix",            kind: "mixed",  sig: ["wixstatic.com", "x-wix-", "wix-warmup", "wixcode"] },
  { name: "Squarespace",    kind: "mixed",  sig: ["squarespace.com", "static1.squarespace", "squarespace-cdn"] },
  { name: "Webflow",        kind: "mixed",  sig: ["webflow.io", "assets.website-files.com", "data-wf-"] },
  { name: "Odoo",           kind: "mixed",  sig: ["odoo", "web/static/src"] },
];
const STORE_MARKERS = [
  "add to cart", "addtocart", "add-to-cart", "add_to_cart", "/cart", "checkout", "data-product",
  "product-grid", "is-commerce", "shopping-cart", "basket", "data-product-id",
  // structured-data / meta signals — catch JS SPAs (e.g. takealot) whose raw HTML has no cart text
  '"@type":"product"', '"@type": "product"', '"@type":"offer"', '"@type":"itemlist"',
  '"@type":"store"', '"@type":"onlinestore"', 'og:type" content="product', 'property="product:price',
];
const GATEWAYS = [
  [/payfast/i, "PayFast"], [/paystack/i, "Paystack"], [/peach.?payment/i, "Peach Payments"],
  [/\bozow\b/i, "Ozow"], [/\byoco\b/i, "Yoco"], [/paypal/i, "PayPal"], [/stripe/i, "Stripe"],
  [/flutterwave/i, "Flutterwave"], [/\bpayu\b/i, "PayU"], [/\bmpesa\b/i, "M-Pesa"],
];

// Pure-domain pre-filter: cut the obvious non-stores before spending a fetch on them.
function nonStoreDomain(d) {
  if (/\.(gov|edu|mil)(\.[a-z]{2,3})?$/.test(d)) return true;          // governments, schools, military
  if (/\.ac\.[a-z]{2,3}$/.test(d)) return true;                        // universities (.ac.za, .ac.uk)
  if (/\.gov\.[a-z]{2,3}$/.test(d)) return true;
  if (/(porn|xvideos|xnxx|xhamster|rule34|\bsex\b|hentai|camsoda|onlyfans|\bixxx\b|\bxxx\b)/.test(d)) return true;
  return GLOBAL_BLOCK.has(d);
}
// High-traffic global/utility sites that rank everywhere but are never a ZA ecommerce LEAD.
const GLOBAL_BLOCK = new Set([
  "facebook.com","google.com","youtube.com","instagram.com","tiktok.com","twitter.com","x.com","whatsapp.com",
  "linkedin.com","reddit.com","pinterest.com","wikipedia.org","spotify.com","netflix.com","microsoft.com",
  "apple.com","amazon.com","airbnb.co.za","airbnb.com","tripadvisor.co.za","tripadvisor.com","booking.com",
  "livescore.com","livescore.in","livescore.cz","soccerway.com","soccervista.com","flashscore.com",
  "ilovepdf.com","canva.com","office.com","bing.com","yahoo.com","duckduckgo.com","telegram.org",
  "github.com","stackoverflow.com","lg.com","samsung.com","roblox.com","discord.com","twitch.tv",
  "news24.com","iol.co.za","timeslive.co.za","ewn.co.za","sabcnews.com","dailymaverick.co.za",
]);

async function fetchPage(domain) {
  for (const host of [domain, `www.${domain}`]) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let res;
      try {
        res = await fetch(`https://${host}/`, { headers: { "User-Agent": UA, Accept: "text/html,*/*" }, signal: AbortSignal.timeout(14000), redirect: "follow" });
      } catch (e) { if (e.name === "TimeoutError") break; else break; }
      if (res.status === 429 || res.status >= 500) { if (attempt < 2) { await sleep(1500 * (attempt + 1)); continue; } return { dead: false, retriable: true }; }
      if (!res.ok) break;                                 // try www, else dead
      const html = (await res.text().catch(() => "")).slice(0, 900_000);
      return { html, finalHost: norm(new URL(res.url).hostname) };
    }
  }
  return { dead: true };
}

function classify(html) {
  const hay = html.toLowerCase();
  let platform = null, kind = null;
  for (const p of PLATFORMS) if (p.sig.some((s) => hay.includes(s))) { platform = p.name; kind = p.kind; break; }
  const hasStoreMarkers = STORE_MARKERS.some((m) => hay.includes(m));
  const gateways = [...new Set(GATEWAYS.filter(([re]) => re.test(html)).map(([, n]) => n))];
  // native platform → store; mixed → store only with markers; none → 'custom' only with real store
  // markers. A payment gateway ALONE is NOT enough: betting/booking/donation sites all carry one
  // (Ozow/Stripe) without being retail stores — require cart/checkout/product/structured-data.
  let verdict, outPlatform = platform;
  if (kind === "native") verdict = "store";
  else if (kind === "mixed") verdict = hasStoreMarkers ? "store" : "not_store";
  else if (hasStoreMarkers) { verdict = "custom"; outPlatform = "custom"; }
  else verdict = "not_store";
  return { verdict, platform: outPlatform, gateways };
}

async function candidateDomains(sql, month) {
  const url = `https://raw.githubusercontent.com/zakird/crux-top-lists/main/data/country/${COUNTRY.toLowerCase()}/${month}.csv.gz`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CrUX ${COUNTRY}/${month} HTTP ${res.status}`);
  const rl = createInterface({ input: Readable.fromWeb(res.body).pipe(createGunzip()), crlfDelay: Infinity });
  const best = new Map();
  for await (const line of rl) {
    const i = line.lastIndexOf(",");
    if (i < 1) continue;
    const rank = +line.slice(i + 1);
    if (!rank || rank > MAX_RANK) continue;
    const d = norm(line.slice(0, i));
    if (nonStoreDomain(d)) continue;
    const cur = best.get(d);
    if (cur === undefined || rank < cur) best.set(d, rank);
  }
  // drop what we already track or already probed
  const have = new Set();
  let last = "";
  for (;;) {
    const rows = await sql`SELECT domain FROM imported_stores WHERE domain > ${last} ORDER BY domain LIMIT 50000`;
    if (!rows.length) break;
    for (const r of rows) have.add(norm(r.domain));
    last = rows[rows.length - 1].domain;
  }
  const probed = new Set((await sql`SELECT domain FROM ranked_ingest_log WHERE cc = ${COUNTRY}`).map((r) => r.domain));
  return [...best.entries()].filter(([d]) => !have.has(d) && !probed.has(d)).sort((a, b) => a[1] - b[1]).slice(0, LIMIT);
}

async function latestMonth() {
  // probe backwards from a recent month until the CrUX CSV exists
  const now = new Date();
  for (let k = 1; k <= 8; k++) {
    const dt = new Date(now.getFullYear(), now.getMonth() - k, 1);
    const m = `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, "0")}`;
    const url = `https://raw.githubusercontent.com/zakird/crux-top-lists/main/data/country/${COUNTRY.toLowerCase()}/${m}.csv.gz`;
    const r = await fetch(url, { method: "HEAD" });
    if (r.ok) return m;
  }
  throw new Error("no recent CrUX month found");
}

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: Math.min(CONC + 1, 6), idle_timeout: 20 });
try {
  await sql`CREATE TABLE IF NOT EXISTS ranked_ingest_log (
    domain TEXT PRIMARY KEY, cc TEXT, rank INT, verdict TEXT, platform TEXT,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
  const month = MONTH || (await latestMonth());
  const cands = await candidateDomains(sql, month);
  console.log(`ingest-ranked: ${COUNTRY} ${month} · ${cands.length} untracked candidates (rank<=${MAX_RANK}, conc ${CONC})${DRY ? " [DRY]" : ""}`);

  let store = 0, custom = 0, notStore = 0, dead = 0, done = 0;
  const byPlat = new Map();
  let i = 0;
  async function worker() {
    while (i < cands.length) {
      const [domain, rank] = cands[i++];
      const r = await fetchPage(domain);
      if (r.retriable) { await sleep(PAUSE_MS); continue; }   // skip this run; eligible next run
      let verdict, platform = null, gateways = [];
      if (r.dead) { verdict = "dead"; dead++; }
      else { ({ verdict, platform, gateways } = classify(r.html)); }
      if (verdict === "store" || verdict === "custom") {
        if (verdict === "custom") custom++; else store++;
        byPlat.set(platform ?? "?", (byPlat.get(platform ?? "?") ?? 0) + 1);
        const pay = gateways.length ? gateways.join("; ") : null;
        if (!DRY) await sql`INSERT INTO imported_stores (domain, country, platform, published, source, crux_rank, crux_rank_month, payments, discovered_at)
          VALUES (${domain}, ${COUNTRY}, ${platform}, false, ${"crux-ranked"}, ${rank}, ${month}, ${pay}, now())
          ON CONFLICT (domain) DO NOTHING`.catch((e) => { console.error(`  insert ${domain}: ${e.message}`); });
      } else if (verdict === "not_store") notStore++;
      if (!DRY) await sql`INSERT INTO ranked_ingest_log (domain, cc, rank, verdict, platform)
        VALUES (${domain}, ${COUNTRY}, ${rank}, ${verdict}, ${platform})
        ON CONFLICT (domain) DO UPDATE SET verdict=EXCLUDED.verdict, platform=EXCLUDED.platform, checked_at=now()`.catch(() => {});
      if (DRY) console.log(`  ${String(rank).padStart(7)}  ${verdict.padEnd(9)} ${(platform ?? "").padEnd(12)} ${domain}`);
      if (!DRY && ++done % 200 === 0) console.log(`  …${done}/${cands.length}  stores=${store} custom=${custom} not_store=${notStore} dead=${dead}`);
      await sleep(PAUSE_MS);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log(`\n${DRY ? "would import" : "imported"}: ${store} platform-stores + ${custom} custom · not_store ${notStore} · dead ${dead}`);
  console.log("by platform:", [...byPlat.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p}=${n}`).join(", ") || "(none)");
} finally { await sql.end(); }
