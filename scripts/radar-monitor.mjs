#!/usr/bin/env node
/**
 * Radar monitoring sweep — the always-on half of Radar.
 *
 * Compares cached store fingerprints against enrolled brand fingerprints
 * (radar_brands) and records clone detections (radar_detections). This is what
 * turns a one-off audit into ongoing protection: once a brand is on file, every
 * newly-fingerprinted store is checked against it automatically.
 *
 *   node --env-file=.env.local scripts/radar-monitor.mjs           # incremental
 *   node --env-file=.env.local scripts/radar-monitor.mjs --all     # full re-scan
 *   node --env-file=.env.local scripts/radar-monitor.mjs --since 14 --min 30
 *
 * Incremental logic (the default): a brand fingerprinted in the last N days is
 * compared against ALL stores (catch clones that predate enrolment); an older
 * brand is compared only against stores fingerprinted in the last N days (catch
 * newly-discovered clones). --all compares every brand against every store.
 *
 * Pure computation over already-cached fingerprints — no merchant fetches — so
 * it's cheap and safe to run often. Scoring MIRRORS lib/radar/catalog.ts; keep
 * the weights below in sync if that file changes.
 */

import postgres from "postgres";

const ALL = process.argv.includes("--all");
const sinceArg = process.argv.indexOf("--since");
const SINCE_DAYS = sinceArg > -1 ? Number(process.argv[sinceArg + 1]) : 7;
const minArg = process.argv.indexOf("--min");
const MIN_SCORE = minArg > -1 ? Number(process.argv[minArg + 1]) : 25;

// --- scoring (mirrors lib/radar/catalog.ts) ---------------------------------
const W_IMAGE = 34, W_SKU = 26, W_HANDLE = 22, W_TITLE = 18;

function containment(a, b) {
  if (a.size === 0 || b.size === 0) return [0, 0];
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const x of small) if (large.has(x)) inter++;
  return [inter / small.size, inter];
}

const verdictFor = (s) => (s >= 75 ? "COPY" : s >= 50 ? "LIKELY" : s >= 25 ? "PARTIAL" : "clean");

function compare(brand, suspect) {
  if (!brand.n || !suspect.n) return null;
  const [imgR, imgN] = containment(brand.imageStems, suspect.imageStems);
  const [skuR, skuN] = containment(brand.skus, suspect.skus);
  const [hndR, hndN] = containment(brand.handles, suspect.handles);
  const [ttlR, ttlN] = containment(brand.titles, suspect.titles);

  const matched = [...brand.handles].filter((h) => suspect.handles.has(h));
  const priced = matched.filter((h) => brand.priceByHandle.has(h) && suspect.priceByHandle.has(h));
  let priceMirror = 0;
  if (priced.length) {
    const same = priced.filter(
      (h) => Math.abs(brand.priceByHandle.get(h) - suspect.priceByHandle.get(h)) < 0.01,
    ).length;
    priceMirror = same / priced.length;
  }

  let score = W_IMAGE * imgR + W_SKU * skuR + W_HANDLE * hndR + W_TITLE * ttlR;
  score *= 1 + 0.15 * priceMirror;
  score = Math.min(100, Math.round(score));

  const pct = (r) => `${Math.round(r * 100)}%`;
  const reasons = [];
  if (imgN) reasons.push(`${imgN} identical product images (${pct(imgR)} of the smaller catalogue)`);
  if (skuN) reasons.push(`${skuN} identical SKUs`);
  if (hndN) reasons.push(`${hndN} identical product handles`);
  if (ttlN) reasons.push(`${ttlN} identical product titles`);
  if (priceMirror) reasons.push(`prices mirrored on ${pct(priceMirror)} of shared products`);

  return { score, verdict: verdictFor(score), reasons };
}

const toFp = (r) => ({
  n: r.n_products,
  imageStems: new Set(r.image_stems),
  skus: new Set(r.skus),
  handles: new Set(r.handles),
  titles: new Set(r.titles),
  priceByHandle: new Map(Object.entries(r.price_by_handle || {})),
});

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3 });
  try {
    await sql`SELECT 1`; // fail fast on a bad DATABASE_URL
    const brands = await sql`
      SELECT brand_domain, brand_name, market, official_domains, n_products,
             image_stems, skus, handles, titles, price_by_handle, fingerprinted_at
      FROM radar_brands WHERE monitoring AND n_products > 0`;
    if (!brands.length) { console.log("No monitored brands enrolled — nothing to sweep."); return; }

    const cutoff = new Date(Date.now() - SINCE_DAYS * 864e5);
    console.log(`Sweeping ${brands.length} brand(s)${ALL ? " [full re-scan]" : ` (incremental, ${SINCE_DAYS}d)`}, min score ${MIN_SCORE}…\n`);

    let comparisons = 0, hits = 0;
    for (const b of brands) {
      const brandFp = toFp(b);
      const allow = new Set(b.official_domains || []);
      // Recent brand (or --all) → scan every store; older brand → recent stores only.
      const brandIsRecent = ALL || new Date(b.fingerprinted_at) >= cutoff;
      const stores = brandIsRecent
        ? await sql`SELECT domain, name, n_products, image_stems, skus, handles, titles, price_by_handle
                    FROM store_fingerprints WHERE status = 'ok' AND market = ${b.market}`
        : await sql`SELECT domain, name, n_products, image_stems, skus, handles, titles, price_by_handle
                    FROM store_fingerprints WHERE status = 'ok' AND market = ${b.market}
                      AND enriched_at >= ${cutoff}`;

      let brandHits = 0;
      for (const s of stores) {
        if (allow.has(s.domain)) continue; // the brand's own / authorised stores
        comparisons++;
        const rep = compare(brandFp, toFp(s));
        if (!rep || rep.score < MIN_SCORE) continue;
        await sql`
          INSERT INTO radar_detections (
            brand_domain, suspect, brand_name, suspect_name, verdict, score, reasons, last_seen_at
          ) VALUES (
            ${b.brand_domain}, ${s.domain}, ${b.brand_name}, ${s.name},
            ${rep.verdict}, ${rep.score}, ${sql.json(rep.reasons)}, now()
          )
          ON CONFLICT (brand_domain, suspect) DO UPDATE SET
            verdict = EXCLUDED.verdict, score = EXCLUDED.score, reasons = EXCLUDED.reasons,
            suspect_name = EXCLUDED.suspect_name, last_seen_at = now()`;
        hits++; brandHits++;
        console.log(`  ⚑ ${s.domain}  →  copying ${b.brand_domain}  [${rep.verdict} ${rep.score}]`);
      }
      console.log(`— ${b.brand_domain}: ${stores.length} store(s) checked, ${brandHits} detection(s)`);
    }
    console.log(`\nDone. ${comparisons} comparisons, ${hits} detection(s) recorded/refreshed.`);
  } finally { await sql.end(); }
}

main().catch((e) => { console.error("failed:", e.message); process.exit(1); });
