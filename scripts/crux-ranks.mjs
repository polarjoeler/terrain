#!/usr/bin/env node
/** crux-ranks — record Chrome UX Report traffic-rank buckets for our stores, as a TIME SERIES.
 *
 *  CrUX publishes `experimental.popularity.rank` — a log10 popularity bucket (top 1k / 5k / 10k /
 *  50k / 100k / 500k / 1M) per origin, per country, per month. We read it from the public
 *  per-country CSV snapshots rather than BigQuery: same data, no GCP project, no bytes billed.
 *  Measured coverage of our Shopify stores: ZA 17.0%, JP 36.6% (vs Tranco's 1.0%/2.5%), and
 *  81-98% of stores above $100k/mo — so it is our best free revenue proxy. The bucket is
 *  monotonic against revenue (ZA top-5k = 77% are >=$10k/mo vs an 11% base), so store the
 *  bucket, not a derived score.
 *
 *  Rows land in `crux_ranks` (domain, month, cc) — append-only, so re-running with a NEWER month
 *  automatically yields a delta and nothing is overwritten. `--promote` then refreshes the
 *  convenience columns on imported_stores (latest rank + previous + trend) for browse/filtering.
 *
 *    node --env-file=.env.local scripts/crux-ranks.mjs --months 202608,202602 --countries za,jp
 *    node --env-file=.env.local scripts/crux-ranks.mjs --months 202608 --all --promote
 *    node --env-file=.env.local scripts/crux-ranks.mjs --months 202608 --all --platform Shopify
 *    node --env-file=.env.local scripts/crux-ranks.mjs --promote-only
 *
 *  Source is a third-party mirror of the CrUX BigQuery export and lags ~2 months; it is a
 *  dependency to watch (cf. crt.sh). Our own GCP project can query CrUX directly for fresher
 *  data once the service account is granted bigquery.jobs.create.
 */
import postgres from "postgres";
import { createGunzip } from "zlib";
import { Readable } from "stream";
import { createInterface } from "readline";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const MONTHS = (arg("--months", "202608") || "").split(",").map(s => s.trim()).filter(Boolean);
const ALL = process.argv.includes("--all");
const PROMOTE = process.argv.includes("--promote");
const PROMOTE_ONLY = process.argv.includes("--promote-only");
const CONC = parseInt(arg("--concurrency", "6"), 10);
// CrUX ranks any origin with enough Chrome traffic, so this is deliberately PLATFORM-AGNOSTIC:
// WooCommerce/Wix/Magento storefronts need the traffic signal just as much as Shopify ones, and
// in ZA the non-Shopify stores outnumber the Shopify ones. Pass --platform to narrow.
const PLATFORM = arg("--platform", null);
const BASE = "https://raw.githubusercontent.com/zakird/crux-top-lists/main/data/country";

// CrUX directories are ISO-2; our data carries a couple of non-ISO labels.
const CC_FIX = { UK: "gb", EU: null };
const norm = (d) => d.toLowerCase().replace(/^www\./, "");

async function ourDomains(sql) {
  // Every store we hold, whatever its platform (including platform-NULL rows we have not yet
  // classified) — the rank is a property of the domain, not of the CMS.
  const out = new Map();                       // normalised domain -> actual stored domain
  let last = "";
  for (;;) {
    const plat = PLATFORM ? sql`AND platform = ${PLATFORM}` : sql``;
    const rows = await sql`SELECT domain FROM imported_stores
      WHERE domain > ${last} ${plat} ORDER BY domain LIMIT 50000`;
    if (!rows.length) break;
    for (const r of rows) out.set(norm(r.domain), r.domain);
    last = rows[rows.length - 1].domain;
  }
  return out;
}

async function fetchMonth(cc, month, mine) {
  const url = `${BASE}/${cc}/${month}.csv.gz`;
  const res = await fetch(url);
  if (res.status === 404) return { cc, month, missing: true, hits: [] };
  if (!res.ok) throw new Error(`${cc}/${month} HTTP ${res.status}`);
  const rl = createInterface({
    input: Readable.fromWeb(res.body).pipe(createGunzip()), crlfDelay: Infinity });
  // CrUX lists each ORIGIN, so http://x, https://x and https://www.x are separate rows that
  // normalise to one domain. Keep the best (lowest) bucket per domain, or the batch upsert
  // hits "ON CONFLICT DO UPDATE cannot affect row a second time".
  const best = new Map();
  let seen = 0;
  for await (const line of rl) {
    const i = line.lastIndexOf(",");
    if (i < 1) continue;
    const rank = +line.slice(i + 1);
    if (!rank) continue;                        // header row
    seen++;
    const d = norm(line.slice(0, i).replace(/^https?:\/\//, ""));
    const stored = mine.get(d);
    if (!stored) continue;
    const cur = best.get(stored);
    if (cur === undefined || rank < cur) best.set(stored, rank);
  }
  const hits = [...best].map(([domain, rank]) => ({ domain, month, cc: cc.toUpperCase(), rank }));
  return { cc, month, seen, hits };
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 4, idle_timeout: 20 });
  try {
    // New table — CREATE is cheap and takes no lock on imported_stores.
    await sql`CREATE TABLE IF NOT EXISTS crux_ranks (
      domain TEXT NOT NULL, month TEXT NOT NULL, cc TEXT NOT NULL,
      rank INTEGER NOT NULL, landed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (domain, month, cc))`;
    await sql`CREATE INDEX IF NOT EXISTS crux_ranks_domain_idx ON crux_ranks (domain)`;
    await sql`CREATE INDEX IF NOT EXISTS crux_ranks_month_idx  ON crux_ranks (month)`;

    if (!PROMOTE_ONLY) {
      const mine = await ourDomains(sql);
      console.log(`our domains in scope: ${mine.size}${PLATFORM ? ` (platform=${PLATFORM})` : " (all platforms)"}`);
      let ccs;
      if (ALL) {
        const r = await sql`SELECT UPPER(country) c FROM imported_stores
          WHERE country IS NOT NULL ${PLATFORM ? sql`AND platform = ${PLATFORM}` : sql``}
          GROUP BY 1 HAVING count(*) >= 200 ORDER BY count(*) DESC`;
        ccs = r.map((x) => (x.c in CC_FIX ? CC_FIX[x.c] : x.c.toLowerCase())).filter(Boolean);
      } else {
        ccs = (arg("--countries", "za,jp") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      }
      ccs = [...new Set(ccs)];
      const jobs = [];
      for (const m of MONTHS) for (const cc of ccs) jobs.push([cc, m]);
      console.log(`fetching ${jobs.length} country-months (${ccs.length} countries x ${MONTHS.length} months), concurrency ${CONC}\n`);

      let i = 0, done = 0, landed = 0, missing = 0, scanned = 0;
      const worker = async () => {
        while (i < jobs.length) {
          const [cc, m] = jobs[i++];
          try {
            const r = await fetchMonth(cc, m, mine);
            if (r.missing) { missing++; }
            else {
              scanned += r.seen;
              for (let k = 0; k < r.hits.length; k += 1000) {
                const batch = r.hits.slice(k, k + 1000);
                await sql`INSERT INTO crux_ranks ${sql(batch, "domain", "month", "cc", "rank")}
                  ON CONFLICT (domain, month, cc) DO UPDATE SET rank = EXCLUDED.rank`;
              }
              landed += r.hits.length;
            }
          } catch (e) { console.log(`  ! ${cc}/${m}: ${e.message}`); }
          done++;
          if (done % 10 === 0) process.stdout.write(`\r  ${done}/${jobs.length} country-months, ${landed} ranks landed`);
        }
      };
      await Promise.all(Array.from({ length: CONC }, worker));
      console.log(`\ndone: ${landed} rank rows landed from ${scanned.toLocaleString()} CrUX origins scanned (${missing} country-months absent)`);
    }

    if (PROMOTE || PROMOTE_ONLY) {
      // Convenience columns for browse/filtering. ALTER .. IF NOT EXISTS needs ACCESS EXCLUSIVE,
      // which has stalled the discovery writers before — so bound the wait and fail harmlessly
      // rather than queue behind a long read and block every writer behind us.
      await sql`SET lock_timeout = '4s'`;
      try {
        await sql`ALTER TABLE imported_stores
          ADD COLUMN IF NOT EXISTS crux_rank INTEGER,
          ADD COLUMN IF NOT EXISTS crux_rank_month TEXT,
          ADD COLUMN IF NOT EXISTS crux_rank_prev INTEGER,
          ADD COLUMN IF NOT EXISTS crux_trend TEXT`;
      } catch (e) {
        console.log(`\n! could not add columns (${e.message.split("\n")[0]}).`);
        console.log(`  crux_ranks is still fully populated — re-run --promote-only when writers are quiet.`);
        await sql`RESET lock_timeout`;
        return;
      }
      await sql`RESET lock_timeout`;
      // Best (lowest) bucket per domain for the latest and previous month we hold.
      const [{ months }] = await sql`SELECT array_agg(DISTINCT month ORDER BY month DESC) months FROM crux_ranks`;
      if (!months || months.length === 0) { console.log("no crux_ranks rows yet"); return; }
      const latest = months[0], prev = months[1] ?? null;
      console.log(`\npromoting: latest=${latest}${prev ? `, previous=${prev}` : " (no earlier month yet)"}`);
      const r = await sql`
        WITH cur AS (SELECT domain, min(rank) rank FROM crux_ranks WHERE month = ${latest} GROUP BY domain),
             old AS (SELECT domain, min(rank) rank FROM crux_ranks WHERE month = ${prev} GROUP BY domain)
        UPDATE imported_stores s
           SET crux_rank = cur.rank,
               crux_rank_month = ${latest},
               crux_rank_prev = old.rank,
               crux_trend = CASE
                 WHEN old.rank IS NULL           THEN 'new'
                 WHEN cur.rank < old.rank        THEN 'up'
                 WHEN cur.rank > old.rank        THEN 'down'
                 ELSE 'flat' END
          FROM cur LEFT JOIN old USING (domain)
         WHERE s.domain = cur.domain
           AND (s.crux_rank IS DISTINCT FROM cur.rank OR s.crux_rank_month IS DISTINCT FROM ${latest})
        RETURNING 1`;
      console.log(`promoted ${r.length} stores`);
    }
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
