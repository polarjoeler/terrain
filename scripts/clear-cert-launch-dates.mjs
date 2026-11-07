/** One-off (2026-11-07): clear cert-sourced launch dates. A cert not_before is usually a renewal
 *  (≈ when we found the store), not a launch; every launch key ignores them already (#97, #110),
 *  and clearing them puts those stores back in the catalog-enrich / launch-enrich queues, which
 *  only date stores with no launched_at. cert_not_before is untouched.
 *
 *  Backs up (domain, launched_at) to jsonl first. Restore: UPDATE launched_at from the file,
 *  launched_source = 'cert'. Batches of 2,000 with a short pause (DB contention limits).
 *
 *    node --env-file=.env.local scripts/clear-cert-launch-dates.mjs [backup.jsonl]
 */
import postgres from "postgres";
import fs from "fs";

const out = process.argv[2] || "logs/bak/cert-launch-dates.jsonl";
const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1, idle_timeout: 20 });
try {
  await sql`SET statement_timeout = '60s'`;
  await sql`SET lock_timeout = '3s'`;
  const rows = [];
  for await (const b of sql`SELECT domain, launched_at::date::text AS launched_at FROM imported_stores WHERE launched_source = 'cert'`.cursor(5000)) rows.push(...b);
  fs.writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`Backed up ${rows.length.toLocaleString()} rows → ${out}`);

  let done = 0;
  for (let i = 0; i < rows.length; i += 2000) {
    const ds = rows.slice(i, i + 2000).map((r) => r.domain);
    for (let t = 0; ; t++) {
      try {
        const r = await sql`UPDATE imported_stores SET launched_at = NULL, launched_source = NULL
                            WHERE domain = ANY(${ds}::text[]) AND launched_source = 'cert'`;
        done += r.count;
        break;
      } catch (e) {
        if (t >= 4) throw e;
        await new Promise((s) => setTimeout(s, 3000 * (t + 1)));
      }
    }
    if ((i / 2000) % 25 === 0) console.log(`  ${done.toLocaleString()}/${rows.length.toLocaleString()}`);
    await new Promise((s) => setTimeout(s, 150));
  }
  const [{ left }] = await sql`SELECT count(*)::int AS left FROM imported_stores WHERE launched_source = 'cert'`;
  console.log(`✓ Cleared ${done.toLocaleString()}; cert rows left: ${left}`);
} finally {
  await sql.end();
}
