/** compare-sources — head-to-head between two lead sources (e.g. StoreCensus vs StoreLeads).
 *  Answers: who has more, who's fresher (liveness), do they agree on the same stores, and how
 *  much each has that the other misses. Run once both are imported.
 *
 *    node --env-file=.env.local scripts/compare-sources.mjs --a storecensus --b storeleads [--country JP]
 */
import postgres from "postgres";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const A = arg("--a", "storecensus"), B = arg("--b", "storeleads");
const CTY = (arg("--country", "") || "").toUpperCase();

async function stats(sql, source) {
  const cty = CTY ? sql`AND UPPER(country) = ${CTY}` : sql``;
  const [r] = await sql`SELECT
    count(*)::int total,
    count(*) FILTER (WHERE live_checked_at IS NOT NULL)::int checked,
    count(*) FILTER (WHERE live_status='active' OR (live_checked_at IS NOT NULL AND live_status IS NULL))::int live,
    count(*) FILTER (WHERE live_status='dead')::int dead,
    count(*) FILTER (WHERE live_status='migrated')::int migrated,
    count(*) FILTER (WHERE estimated_monthly_sales IS NOT NULL)::int with_sales,
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY estimated_monthly_sales))::bigint median_sales
    FROM imported_stores WHERE source = ${source} ${cty}`;
  return r;
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3, idle_timeout: 20 });
  try {
    const cty = CTY ? sql`AND UPPER(country) = ${CTY}` : sql``;
    const sa = await stats(sql, A), sb = await stats(sql, B);
    const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);
    const line = (label, x) => `  ${label.padEnd(22)} ${A}: ${String(x.a).padStart(8)}   ${B}: ${String(x.b).padStart(8)}`;

    console.log(`\n=== source comparison${CTY ? ` [${CTY}]` : ""} — ${A} vs ${B} ===`);
    console.log(line("total stores", { a: sa.total, b: sb.total }));
    console.log(line("live (of checked)", { a: `${sa.live} (${pct(sa.live, sa.checked)}%)`, b: `${sb.live} (${pct(sb.live, sb.checked)}%)` }));
    console.log(line("dead", { a: sa.dead, b: sb.dead }));
    console.log(line("left Shopify (migr.)", { a: sa.migrated, b: sb.migrated }));
    console.log(line("with sales figure", { a: sa.with_sales, b: sb.with_sales }));
    console.log(line("median sales $/mo", { a: sa.median_sales ?? "—", b: sb.median_sales ?? "—" }));

    // overlap + unique
    const [ov] = await sql`
      SELECT count(*)::int both,
        count(*) FILTER (WHERE has_a AND NOT has_b)::int only_a,
        count(*) FILTER (WHERE has_b AND NOT has_a)::int only_b
      FROM (
        SELECT regexp_replace(domain,'^www\\.','') d,
          bool_or(source=${A}) has_a, bool_or(source=${B}) has_b
        FROM imported_stores WHERE source IN (${A}, ${B}) ${cty} GROUP BY 1
      ) x`;
    console.log(`\n  overlap (in both):        ${ov.both}`);
    console.log(`  only in ${A}:  ${ov.only_a}`);
    console.log(`  only in ${B}:  ${ov.only_b}`);
    if (sb.total === 0) console.log(`\n  (${B} not imported yet — import it, then re-run for the full head-to-head.)`);
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
