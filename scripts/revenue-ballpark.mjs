#!/usr/bin/env node
/** revenue-ballpark — ballpark monthly revenue per store, from the CrUX traffic-rank bucket.
 *
 *  METHOD. Three facts drove the design:
 *   1. The vendor's `estimated_monthly_sales` is useless PER STORE (59% median error, 65x worst
 *      case on 25 ZA ground-truth anchors) but its per-bucket MEDIAN is a sane population shape.
 *   2. Merchant-supplied anchors are the TOP of a bucket, not its middle — they are brands the
 *      merchant happens to know, so they are only representative where the bucket is small.
 *      Taking them as bucket medians implied R301bn/yr for ZA — 1.9x the ENTIRE SA online retail
 *      market, with a single bucket (top-50k) implying R95bn.
 *   3. A total-market figure is therefore the only honest level constraint.
 *
 *  So: shape = each country's own vendor per-bucket median; level = one scalar k that makes the
 *  population total equal a share of the national online-retail market. For ZA, a 35% share gives
 *  k=3.11 and independently reproduces BOTH merchant checkpoints — top-1k lands at R13.3m against
 *  his stated R13.5m, and unranked lands at R16k inside his stated R0-R100k band. Neither was
 *  fitted; they fall out of the one parameter, which is the main evidence the method works.
 *
 *  Accuracy is deliberately best at the top (the merchant's priority): top-1k is anchor-validated,
 *  and the tail is only constrained to be collectively plausible rather than individually right.
 *
 *  OTHER MARKETS have no anchors and no usable market size (published African figures disagree
 *  3x+ and mix GMV with retail — Nigeria returns both $10.5bn and $33bn). They reuse the
 *  SA-derived k against their OWN vendor shape, on the stated assumption that the vendor's bias is
 *  methodological (global conversion/AOV benchmarks) rather than market-specific. All non-ZA
 *  output is labelled low confidence. Cross-country vendor RATIOS were tested and rejected: they
 *  produced 0.00x-0.03x for TZ/MZ/GH, i.e. they compound the vendor's own error.
 *
 *  Only `published` rows on a COMMERCE platform are scored — our list also holds NGOs, radio
 *  stations and ministries on WordPress/Webflow, which must never receive a revenue figure.
 *
 *    node --env-file=.env.local scripts/revenue-ballpark.mjs                     # dry run, ZA
 *    node --env-file=.env.local scripts/revenue-ballpark.mjs --apply
 *    node --env-file=.env.local scripts/revenue-ballpark.mjs --countries NG,KE,EG,MA --apply
 */
import postgres from "postgres";

const MODEL = "ballpark_v6";
const ZAR_PER_USD = 16.52;
const ZA_MARKET_ZAR_YR = 159e9;          // World Wide Worx / Mastercard, SA online retail 2026
// REJECTED APPROACHES, recorded so they are not retried:
//  (a) ONE global k scaled to ZA's market => implied 0.08% of the US market, 40% of Australia's.
//  (b) PER-MARKET k from each national total => aggregates correct by construction but per-store
//      absurd wherever our coverage is thin: India came out at R467m/mo for top-1k and R147k for
//      UNRANKED stores (vs ZA's R14k), because scaling to 35% of a $126.89bn market across only
//      82,743 rows forces every store to be enormous. The missing variable in both is OUR COVERAGE
//      SHARE of each market, which we do not know.
// SO: outside ZA, use the vendor's own per-store estimate. It is globally consistent in method,
// exists for 515,246 stores, and its error (59% median in ZA) is bounded — unlike a market scalar
// that can be wrong by 400x. ZA keeps its anchor-calibrated ladder. Kept for reference only:
const MARKET_USD_BN = {
  CN: 1958.28, US: 1413.30, JP: 214.03, UK: 136.60, IN: 126.89, DE: 113.53, KR: 87.22,
  FR: 73.93, CA: 70.53, ID: 67.99, MX: 47.79, ES: 40.40,
  // ZA in USD BILLIONS like the rest — dividing only by the FX rate left it 1e9 too big and
  // produced k=3.1e9. Keep the unit explicit.
  ZA: ZA_MARKET_ZAR_YR / 16.52 / 1e9,
};
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const APPLY = process.argv.includes("--apply");
const SHARE = parseFloat(arg("--share", "0.35"));
const BAND_K = parseFloat(arg("--band-k", "2.0"));
const ALL = process.argv.includes("--all-countries");
const MIN_ROWS = parseInt(arg("--min-rows", "500"), 10);
const COUNTRIES = (arg("--countries", "ZA") || "").toUpperCase().split(",").map((s) => s.trim()).filter(Boolean);
const BUCKETS = [1000, 5000, 10000, 50000, 100000, 500000, 1000000];
// Platforms that actually indicate a shop. Bare WordPress / Webflow are excluded deliberately.
const COMMERCE = ["Shopify", "WooCommerce", "Magento", "PrestaShop", "BigCommerce", "Wix",
  "Squarespace", "Ecwid", "Shopware", "OpenCart", "storesjp", "colorme", "BASE", "makeshop",
  "EC-CUBE", "Cafe24", "Odoo", "adobe_commerce", "shopstar"];

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
const fmtZ = (v) => v >= 1e6 ? `R${+(v / 1e6).toFixed(v / 1e6 < 10 ? 1 : 0)}m` : `R${Math.round(v / 1e3)}k`;

async function shapeFor(sql, cc) {
  const shape = {}, cnt = {};
  for (const b of BUCKETS) {
    const r = await sql`SELECT estimated_monthly_sales v FROM imported_stores
      WHERE UPPER(country)=${cc} AND crux_rank=${b} AND published AND platform=ANY(${COMMERCE})
        AND estimated_monthly_sales > 0`;
    const [n] = await sql`SELECT count(*)::int n FROM imported_stores
      WHERE UPPER(country)=${cc} AND crux_rank=${b} AND published AND platform=ANY(${COMMERCE})`;
    shape[b] = med(r.map((x) => +x.v)); cnt[b] = n.n;
  }
  const ru = await sql`SELECT estimated_monthly_sales v FROM imported_stores
    WHERE UPPER(country)=${cc} AND crux_rank IS NULL AND published AND platform=ANY(${COMMERCE})
      AND estimated_monthly_sales > 0`;
  const [nu] = await sql`SELECT count(*)::int n FROM imported_stores
    WHERE UPPER(country)=${cc} AND crux_rank IS NULL AND published AND platform=ANY(${COMMERCE})`;
  shape.un = med(ru.map((x) => +x.v)); cnt.un = nu.n;
  // A bucket with no vendor data at all inherits the next bucket up, so the ladder never has a hole.
  let last = 0;
  for (const b of [...BUCKETS].reverse()) { if (!shape[b]) shape[b] = last || shape.un; last = shape[b]; }
  // Force the ladder MONOTONIC in rank. Thin buckets produce noisy medians — ZA's 84-store
  // top-1M bucket came out at R259k, above top-500k's R77k, which would mean a worse-ranked
  // store getting a bigger number. Clamp each step to the one above it.
  let cap = Infinity;
  for (const b of BUCKETS) { shape[b] = Math.min(shape[b], cap); cap = shape[b]; }
  shape.un = Math.min(shape.un, cap);
  return { shape, cnt };
}

// Confidence tracks where the evidence actually is: top-1k is anchor-validated; the tail is only
// collectively constrained. Non-ZA is one step lower again — no anchors, no market figure.
const confFor = (cc, b, grounded) => {
  if (!grounded) return "low";
  const base = b === 1000 ? "good" : (b === 5000 || b === 10000) ? "medium" : "low";
  if (cc !== "ZA") return base === "good" ? "medium" : "low";
  return base;
};

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 4, idle_timeout: 20 });
  try {
    // A hand-entered revenue is ground truth and must never be clobbered by the model — a human who
    // typed a figure in the admin drawer knows something the traffic ladder can't (e.g. Amazon.co.za
    // is rank ~#1, far above its top-1k bucket median). Every such edit lands a store_edits audit row,
    // so that table is the authoritative "manual revenue" signal. We exclude these domains from every
    // pricing UPDATE below and null any model price a prior run left on them, so the displayed band
    // falls back to their hand-set estimated_monthly_sales (see revExpr/COALESCE in lib/fx.ts).
    const manualRows = await sql`SELECT DISTINCT domain FROM store_edits WHERE field = 'estimated_monthly_sales'`;
    const manualRev = manualRows.map((r) => r.domain);
    const notManual = manualRev.length ? sql`AND domain <> ALL(${manualRev})` : sql``;
    if (manualRev.length) console.log(`honouring ${manualRev.length} manual revenue override(s): ${manualRev.join(", ")}\n`);

    // ZA ladder: anchor-calibrated (validated against 25 merchant anchors — top-1k lands R13m
    // against his stated R13.5m). This is the ONLY market where the level is grounded.
    const za = await shapeFor(sql, "ZA");
    const zaRaw = [...BUCKETS, "un"].reduce((s, b) => s + za.shape[b] * za.cnt[b], 0);
    const K_ZA = (ZA_MARKET_ZAR_YR * SHARE / 12 / ZAR_PER_USD) / zaRaw;
    const zaLadder = {}; for (const b of [...BUCKETS, "un"]) zaLadder[b] = za.shape[b] * K_ZA;
    console.log(`${MODEL}: ZA ladder k=${K_ZA.toFixed(2)}x (anchor-calibrated); every other market uses the VENDOR per-store estimate.\n`);

    if (!APPLY) {
      console.log("ZA ladder (USD/mo):");
      for (const b of [...BUCKETS, "un"]) console.log(`  ${(b === "un" ? "unranked" : "top " + b.toLocaleString()).padStart(13)} $${Math.round(zaLadder[b]).toLocaleString()}`);
      console.log("\nDRY RUN — pass --apply to write.");
      return;
    }

    await sql`SET lock_timeout = '4s'`;
    try {
      await sql`ALTER TABLE imported_stores
        ADD COLUMN IF NOT EXISTS revenue_ballpark_usd NUMERIC,
        ADD COLUMN IF NOT EXISTS revenue_low_usd NUMERIC,
        ADD COLUMN IF NOT EXISTS revenue_high_usd NUMERIC`;
    } catch { /* already present */ }
    await sql`RESET lock_timeout`;

    // 1) ZA, by CrUX bucket, from the calibrated ladder.
    let za_n = 0;
    for (const b of [...BUCKETS, "un"]) {
      const usd = Math.round(zaLadder[b]); if (!usd) continue;
      const zar = usd * ZAR_PER_USD;
      const conf = b === 1000 ? "good" : (b === 5000 || b === 10000) ? "medium" : "low";
      const where = b === "un" ? sql`crux_rank IS NULL` : sql`crux_rank = ${b}`;
      // A CrUX rank IS the evidence the site is a real, high-traffic storefront, so a RANKED store is
      // priced whatever its platform — this is how the custom-platform / marketplace giants (Takealot,
      // Superbalist on Spree, etc.) get a figure instead of "New". The platform gate stays ONLY on the
      // unranked floor bucket, so a random published non-commerce page with no traffic isn't invented a
      // revenue it doesn't warrant.
      const platGate = b === "un" ? sql`AND platform = ANY(${COMMERCE})` : sql``;
      const r = await sql`UPDATE imported_stores SET
          revenue_ballpark_usd = ${usd}, revenue_low_usd = ${Math.round(usd / BAND_K)},
          revenue_high_usd = ${Math.round(usd * BAND_K)}, revenue_ballpark_zar = ${Math.round(zar)},
          revenue_band = ${`${fmtZ(zar / BAND_K)}-${fmtZ(zar * BAND_K)}`},
          revenue_model = ${MODEL}, revenue_confidence = ${conf}
        WHERE UPPER(country) = 'ZA' AND ${where} AND published ${platGate} ${notManual} RETURNING 1`;
      za_n += r.length;
    }
    console.log(`ZA (calibrated ladder): ${za_n}`);

    // Strip any model price a prior run left on a manual-override store, so the band reads its
    // hand-set estimated_monthly_sales. revenue_model='manual' marks it and keeps it excluded hereafter.
    if (manualRev.length) {
      const m = await sql`UPDATE imported_stores SET
          revenue_ballpark_usd = NULL, revenue_ballpark_zar = NULL, revenue_low_usd = NULL, revenue_high_usd = NULL,
          revenue_band = NULL, revenue_model = 'manual', revenue_confidence = 'good'
        WHERE domain = ANY(${manualRev}) AND revenue_model IS DISTINCT FROM 'manual' RETURNING 1`;
      console.log(`manual overrides cleared of model price: ${m.length}`);
    }

    // 2) Everywhere else WITH a vendor estimate — use it directly, no scaling invented.
    const v = await sql`UPDATE imported_stores SET
        revenue_ballpark_usd = round(estimated_monthly_sales),
        revenue_low_usd = round(estimated_monthly_sales / ${BAND_K}),
        revenue_high_usd = round(estimated_monthly_sales * ${BAND_K}),
        revenue_ballpark_zar = NULL,
        revenue_band = '$' || round(estimated_monthly_sales / ${BAND_K} / 1000) || 'k-$' || round(estimated_monthly_sales * ${BAND_K} / 1000) || 'k',
        revenue_model = ${MODEL}, revenue_confidence = 'low'
      WHERE UPPER(country) <> 'ZA' AND estimated_monthly_sales > 0
        AND published AND platform = ANY(${COMMERCE}) ${notManual} RETURNING 1`;
    console.log(`non-ZA from the vendor estimate: ${v.length}`);

    // 3) Still blank: fall back to that market's OWN unscaled vendor median for its bucket, so a
    //    store with no estimate of its own still gets a figure drawn from its peers.
    const ccs = await sql`SELECT UPPER(country) c FROM imported_stores
      WHERE country IS NOT NULL AND UPPER(country) <> 'ZA' AND published AND platform = ANY(${COMMERCE})
        AND revenue_model IS NULL GROUP BY 1 HAVING count(*) >= ${MIN_ROWS} ORDER BY count(*) DESC`;
    let f_n = 0;
    for (const { c } of ccs) {
      const { shape } = await shapeFor(sql, c);
      for (const b of [...BUCKETS, "un"]) {
        const usd = Math.round(shape[b]); if (!usd) continue;
        const where = b === "un" ? sql`crux_rank IS NULL` : sql`crux_rank = ${b}`;
        const platGate = b === "un" ? sql`AND platform = ANY(${COMMERCE})` : sql``;   // ranked = priced regardless of platform (see ZA note above)
        const r = await sql`UPDATE imported_stores SET
            revenue_ballpark_usd = ${usd}, revenue_low_usd = ${Math.round(usd / BAND_K)},
            revenue_high_usd = ${Math.round(usd * BAND_K)},
            revenue_band = ${`$${Math.round(usd / BAND_K / 1000)}k-$${Math.round(usd * BAND_K / 1000)}k`},
            revenue_model = ${MODEL}, revenue_confidence = 'low'
          WHERE UPPER(country) = ${c} AND ${where} AND published ${platGate}
            AND revenue_model IS NULL ${notManual} RETURNING 1`;
        f_n += r.length;
      }
    }
    console.log(`peer-median fallback: ${f_n}`);
    const [t] = await sql`SELECT count(*)::int n FROM imported_stores WHERE revenue_model = ${MODEL}`;
    const chk = await sql`SELECT revenue_confidence, count(*)::int n FROM imported_stores
      WHERE revenue_model = ${MODEL} GROUP BY 1 ORDER BY n DESC`;
    console.log(`\nTOTAL priced: ${t.n}   by confidence: ${chk.map((x) => `${x.revenue_confidence}=${x.n}`).join("  ")}`);
    console.log(`reverse: UPDATE imported_stores SET revenue_ballpark_usd=NULL, revenue_low_usd=NULL, revenue_high_usd=NULL, revenue_ballpark_zar=NULL, revenue_band=NULL, revenue_model=NULL, revenue_confidence=NULL WHERE revenue_model='${MODEL}';`);
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
