/** Normalise the `apps` and `technologies` columns to one canonical spelling each.
 *
 *    node --env-file=.env.local --experimental-strip-types scripts/normalise-tech-columns.mjs [--commit]
 *
 *  Dry-run by default. See lib/apps-canon.ts for why both columns need this: mixed
 *  delimiters (apps uses ';' and '|', technologies uses ';' and ':'), URL-vs-name forms,
 *  and duplicates within a single row. Normalising BEFORE any large backfill lands is the
 *  point — cleaning 22k rows now is cheap, cleaning them after a 75k backfill is not.
 *
 *  Chunked and change-only: rows whose canonical form already matches are not rewritten,
 *  so a second run is a no-op rather than 75k pointless row versions.
 */
import postgres from "postgres";
import { canonicalApps, canonicalTechnologies } from "../lib/apps-canon.ts";

const COMMIT = process.argv.includes("--commit");
// Scope. Default is the rows actually IN the product — published, focus markets. The global
// StoreCensus base is ~1.8M background rows (published=false, benchmark not resold), and
// rewriting those would be ~2M row versions of WAL and autovacuum on an instance that is
// already CPU-bound, to tidy data nobody queries. --all opts into the full sweep; do it
// paced and off-peak if ever needed.
const ALL = process.argv.includes("--all");
const FOCUS = ["ZA", "KE", "NG"];
const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 2, idle_timeout: 20 });

async function pass(col, canon) {
  const scope = ALL ? sql`` : sql`AND published AND country = ANY(${FOCUS})`;
  const rows = await sql`SELECT domain, ${sql(col)} AS v FROM imported_stores
    WHERE ${sql(col)} IS NOT NULL AND ${sql(col)} <> '' ${scope}`;
  const changes = [];
  for (const r of rows) {
    const next = canon(r.v);
    if (next !== r.v) changes.push({ domain: r.domain, next });
  }
  console.log(`${col}: ${rows.length.toLocaleString()} rows · ${changes.length.toLocaleString()} would change (${(changes.length / Math.max(1, rows.length) * 100).toFixed(1)}%)`);
  for (const c of changes.slice(0, 4)) {
    const before = rows.find((r) => r.domain === c.domain).v;
    console.log(`   ${c.domain}\n     before: ${String(before).slice(0, 86)}\n     after : ${String(c.next).slice(0, 86)}`);
  }
  if (!COMMIT) return 0;
  let n = 0;
  for (let i = 0; i < changes.length; i += 500) {
    const batch = changes.slice(i, i + 500);
    await sql`UPDATE imported_stores AS t SET ${sql(col)} = c.next
      FROM (VALUES ${sql(batch.map((c) => [c.domain, c.next]))}) AS c(domain, next)
      WHERE t.domain = c.domain`;
    n += batch.length;
    if (i % 5000 === 0 && i) console.log(`   … ${i.toLocaleString()}/${changes.length.toLocaleString()}`);
  }
  return n;
}

console.log(ALL ? "scope: ALL rows (global background included)" : `scope: published + ${FOCUS.join("/")} (the rows in the product)`);
try {
  const a = await pass("apps", canonicalApps);
  const t = await pass("technologies", canonicalTechnologies);
  console.log(COMMIT ? `\n✓ rewrote ${(a + t).toLocaleString()} rows` : "\n(dry run — pass --commit to write)");
} finally { await sql.end(); }
