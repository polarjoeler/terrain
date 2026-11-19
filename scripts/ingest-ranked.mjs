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
import { classify, nonStoreDomain } from "./lib/storefront-classify.mjs";

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

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: Math.min(CONC + 1, 6), idle_timeout: 20,
  connection: { statement_timeout: 120000, idle_in_transaction_session_timeout: 120000, lock_timeout: 5000 } });
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
