#!/usr/bin/env node
/**
 * One-off: log the churn that happened while nothing was writing churn_log.
 *
 *   node --env-file=.env.local scripts/backfill-churn-log.mjs            # dry run, counts only
 *   node --env-file=.env.local scripts/backfill-churn-log.mjs --write
 *
 * verify-liveness.mjs is the only churn_log writer and it had no scheduler between 2026-10-24 and
 * the day com.tembo.verify-liveness was loaded (see scripts/verify-liveness.sh). Other lanes kept
 * writing imported_stores.live_status, so the VERDICTS exist — they just never produced a churn
 * row, and Insights counts churn by died_at. This inserts the missing rows from the verdicts
 * already on the stores.
 *
 * Deliberately the SAME projection verify-liveness uses, including:
 *   - `historic` = first_verified_live_at IS NULL, i.e. we never saw it alive, so it is excluded
 *     from period churn rather than dumped into the current month.
 *   - died_at = last_alive_at, the last time we confirmed it live. NULL where we never did, which
 *     keeps an undatable die-off out of the market's churn clock instead of inventing a date.
 *   - ON CONFLICT (domain) DO NOTHING — churn_log's PK is domain and "first churn wins" is
 *     deliberate, so a store that already churned once is left exactly as it is.
 *
 * Scoped to the markets we sell into, matching the lane: a global bare record going dead is not
 * churn anyone is reading. --all lifts that if you ever want the whole table.
 */
import postgres from "postgres";

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const ALL = args.includes("--all");
const MARKETS = "AO,BW,CI,CM,DZ,EG,ET,GH,KE,LS,LY,MA,MU,MW,MZ,NA,NG,RW,SN,SO,SZ,TN,TZ,UG,ZA,ZM,ZW,JP".split(",");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set (run with --env-file=.env.local)");
  process.exit(2);
}
const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 20 });

const scope = ALL ? sql`` : sql`AND UPPER(s.country) = ANY(${MARKETS})`;

const [{ n: pending }] = await sql`
  SELECT count(*) AS n FROM imported_stores s
  WHERE s.live_status IN ('dead', 'migrated') ${scope}
    AND NOT EXISTS (SELECT 1 FROM churn_log c WHERE c.domain = s.domain)`;

const breakdown = await sql`
  SELECT s.live_status, (s.first_verified_live_at IS NULL) AS historic,
         (s.last_alive_at IS NULL) AS undated, count(*) AS n
  FROM imported_stores s
  WHERE s.live_status IN ('dead', 'migrated') ${scope}
    AND NOT EXISTS (SELECT 1 FROM churn_log c WHERE c.domain = s.domain)
  GROUP BY 1, 2, 3 ORDER BY 4 DESC`;

console.log(`${Number(pending).toLocaleString()} store(s) with a dead/migrated verdict and no churn row${ALL ? "" : " (sold markets)"}:\n`);
console.log("  status    historic  undated     count   counts toward period churn?");
for (const r of breakdown) {
  const counts = !r.historic && !r.undated ? "yes" : r.historic ? "no (never seen alive)" : "no (no died_at)";
  console.log(`  ${String(r.live_status).padEnd(10)}${String(r.historic).padEnd(10)}${String(r.undated).padEnd(10)}${String(r.n).padStart(7)}   ${counts}`);
}

if (!WRITE) {
  console.log("\nDry run — nothing written. Re-run with --write to insert these rows.");
  await sql.end();
  process.exit(0);
}

const inserted = await sql`
  INSERT INTO churn_log (domain, name, country, status, migrated_to, first_seen, discovered_at,
    category, theme, city, estimated_monthly_sales, payments, shipping_providers, free_shipping,
    plus, historic, died_at)
  SELECT s.domain, s.name, s.country, s.live_status, s.live_platform, s.first_seen, s.discovered_at,
    s.category, s.theme, s.city, s.estimated_monthly_sales, s.payments, s.shipping_providers,
    s.free_shipping, s.plus, (s.first_verified_live_at IS NULL), s.last_alive_at
  FROM imported_stores s
  WHERE s.live_status IN ('dead', 'migrated') ${scope}
    AND NOT EXISTS (SELECT 1 FROM churn_log c WHERE c.domain = s.domain)
  ON CONFLICT (domain) DO NOTHING
  RETURNING domain`;
console.log(`\nInserted ${inserted.length.toLocaleString()} churn_log row(s).`);
await sql.end();
