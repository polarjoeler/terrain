/** recall-report — the automatic "here's our Shopify coverage this month" number.
 *
 * Reads the per-market Shopify lists Shodan saw (feed/shodan/<market>.txt, written by
 * seed_shodan on the discovery tick — so this costs ZERO extra Shodan credits) and measures
 * what fraction we already track. That's our recall against a near-complete, independent view
 * of Shopify's edge. Stores a datapoint per market + overall in coverage_benchmarks, which the
 * /ops/coverage "Recall benchmarks" panel already renders.
 *
 * If the Shodan lists don't exist yet (no key / not pulled), it exits cleanly.
 *
 *   node --env-file=.env.local scripts/recall-report.mjs
 */
import postgres from "postgres";
import { readdirSync, readFileSync } from "node:fs";

const FEED = process.env.SHODAN_FEED_DIR || "/Users/joel/shopify-radar/feed/shodan";
const norm = (s) => { let d = String(s).trim().toLowerCase().replace(/^www\./, "").replace(/\.+$/, ""); return d.includes(".") && !d.includes(" ") ? d : null; };
const label = (f) => "shopify:" + f.replace(/\.txt$/, "").replace(/_/g, ".");

async function main() {
  let files;
  try { files = readdirSync(FEED).filter((f) => f.endsWith(".txt")); }
  catch { console.log(`No Shodan feed dir (${FEED}) — run seed_shodan (needs SHODAN_API_KEY) first.`); return; }
  if (!files.length) { console.log("No Shodan market files yet — nothing to measure."); return; }

  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3, idle_timeout: 20 });
  try {
    await sql`CREATE TABLE IF NOT EXISTS coverage_benchmarks (
      id bigserial PRIMARY KEY, label text NOT NULL, ran_at timestamptz NOT NULL DEFAULT now(),
      list_total int, present int, missing int, coverage_pct numeric,
      live_missing int, true_recall_pct numeric, source_file text)`;

    let allSeen = new Set(), allPresent = 0;
    const perMarket = [];
    for (const f of files) {
      const seen = [...new Set(readFileSync(`${FEED}/${f}`, "utf8").split("\n").map(norm).filter(Boolean))];
      if (!seen.length) continue;
      const present = (await sql`SELECT count(*)::int n FROM imported_stores
        WHERE lower(regexp_replace(domain,'^www\\.','')) = ANY(${seen})
          AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))`)[0].n;
      const pct = Number(((present / seen.length) * 100).toFixed(1));
      perMarket.push({ label: label(f), total: seen.length, present, pct });
      for (const d of seen) allSeen.add(d);
    }
    // overall — dedup across markets
    const seenArr = [...allSeen];
    for (let i = 0; i < seenArr.length; i += 5000) {
      const chunk = seenArr.slice(i, i + 5000);
      allPresent += (await sql`SELECT count(*)::int n FROM imported_stores
        WHERE lower(regexp_replace(domain,'^www\\.','')) = ANY(${chunk})
          AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))`)[0].n;
    }
    const overall = { label: "shopify:all", total: allSeen.size, present: allPresent, pct: allSeen.size ? Number(((allPresent / allSeen.size) * 100).toFixed(1)) : 0 };

    for (const m of [...perMarket, overall]) {
      await sql`INSERT INTO coverage_benchmarks ${sql({
        label: m.label, list_total: m.total, present: m.present, missing: m.total - m.present,
        coverage_pct: m.pct, true_recall_pct: m.pct, source_file: "shodan/" + FEED.split("/").pop(),
      })}`;
      console.log(`${m.label.padEnd(16)} recall ${String(m.pct).padStart(5)}%  (${m.present}/${m.total})`);
    }
    console.log(`\nStored ${perMarket.length + 1} recall datapoints → coverage_benchmarks (shown on /ops/coverage).`);
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
