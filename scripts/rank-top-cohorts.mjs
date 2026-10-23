/** rank-top-cohorts — tag each market's Top 100 / Top 500 LIVE stores by revenue estimate
 *  (estimated_monthly_sales DESC). Two modes per market:
 *    • CURATED (South Africa by default): existing top-100/top-500 tags are PRESERVED, and we only
 *      top up to the target with the next-highest-revenue untagged live stores. Nothing is removed —
 *      so manual edits (add a store, drop a store) survive a re-run.
 *    • FRESH (every other market): no existing curation, so just tag the top N by revenue.
 *  Only ever ADDS tags. Idempotent. Use --dry-run to preview; --curated ZA,KE to protect more markets.
 *
 *    node --env-file=.env.local scripts/rank-top-cohorts.mjs [--market ZA] [--dry-run] [--curated ZA]
 */
import postgres from "postgres";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const DRY = process.argv.includes("--dry-run");
const ALL = process.argv.includes("--all") || process.argv.includes("--global"); // every country with stores
const ONE = (arg("--market", "") || "").toUpperCase();
const CURATED = new Set((arg("--curated", "ZA") || "").toUpperCase().split(",").filter(Boolean));
const FOCUS = ["ZA", "KE", "NG", "EG", "MA", "GH", "TZ", "UG", "DZ", "TN", "CI", "SN", "MU", "MZ",
  "CM", "BW", "AO", "NA", "RW", "ZM", "ET", "ZW", "LY", "MW", "SO", "LS", "SZ", "JP"];
const TARGETS = [["top-100", 100], ["top-500", 500]];

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3, idle_timeout: 20 });
try {
  const markets = ONE ? [ONE]
    : ALL ? (await sql`SELECT DISTINCT upper(country) c FROM imported_stores
        WHERE published AND country IS NOT NULL AND country <> ''
          AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
          AND activity_tier IS DISTINCT FROM 'not_a_store' AND estimated_monthly_sales IS NOT NULL
        ORDER BY 1`).map((r) => r.c)
    : FOCUS;
  console.log(`ranking ${markets.length} market(s)${ALL ? " (global)" : ""}${DRY ? " [DRY]" : ""} · curated: ${[...CURATED].join(",") || "none"}\n`);
  for (const mkt of markets) {
    // Live stores in this market that have a revenue estimate, best first.
    const ranked = await sql`
      SELECT domain FROM imported_stores
      WHERE published AND upper(country) = ${mkt}
        AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
        AND activity_tier IS DISTINCT FROM 'not_a_store'
        AND estimated_monthly_sales IS NOT NULL
      ORDER BY estimated_monthly_sales DESC`;
    if (!ranked.length) { console.log(`${mkt}: no revenue-estimated live stores — skipped.`); continue; }
    const order = ranked.map((r) => r.domain);

    for (const [tag, target] of TARGETS) {
      const existing = await sql`SELECT st.domain FROM store_tags st JOIN imported_stores i ON i.domain = st.domain
        WHERE st.tag = ${tag} AND upper(i.country) = ${mkt}`;
      const have = new Set(existing.map((r) => r.domain));
      const curated = CURATED.has(mkt);
      let toAdd;
      if (curated) {
        // preserve existing, add highest-revenue untagged until we reach the target
        const need = Math.max(0, target - have.size);
        toAdd = order.filter((d) => !have.has(d)).slice(0, need);
      } else {
        // fresh: the top N by revenue, minus anything already tagged
        toAdd = order.slice(0, target).filter((d) => !have.has(d));
      }
      const note = curated ? `curated: keep ${have.size}, +${toAdd.length} to reach ${Math.min(target, have.size + toAdd.length)}` : `fresh: +${toAdd.length} (had ${have.size})`;
      console.log(`${mkt} ${tag.padEnd(8)} ${note}${toAdd.length && order.length < target ? `  [only ${order.length} revenue-ranked available]` : ""}`);
      if (!DRY && toAdd.length) {
        await sql`INSERT INTO store_tags (domain, tag) SELECT unnest(${toAdd}::text[]), ${tag} ON CONFLICT DO NOTHING`;
      }
    }
  }
  if (DRY) console.log("\n[DRY] no tags written.");
} finally { await sql.end(); }
