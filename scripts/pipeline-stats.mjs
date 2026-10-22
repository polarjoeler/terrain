#!/usr/bin/env node
/** pipeline-stats — point-in-time snapshot of pipeline throughput + per-machine heartbeats.
 *  Read-only. Used to baseline Chad-era output and later measure Rex.
 *    node --env-file=.env.local scripts/pipeline-stats.mjs [--json out.json]
 */
import postgres from "postgres";
import { writeFileSync } from "node:fs";

const ji = process.argv.indexOf("--json");
const outPath = ji > -1 ? process.argv[ji + 1] : null;
const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 2 });

const snap = { captured_at: new Date().toISOString(), host: (await import("node:os")).hostname() };
try {
  // 1. table totals
  const [t] = await sql`SELECT count(*)::bigint total, count(*) FILTER (WHERE published)::bigint published FROM imported_stores`;
  snap.totals = { rows: Number(t.total), published: Number(t.published) };

  // 2. which timestamp columns exist on imported_stores
  const cols = (await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name='imported_stores' AND (data_type LIKE 'timestamp%' OR column_name LIKE '%_at')
    ORDER BY column_name`).map(r => r.column_name);

  // 3. recent activity per timestamp column (24h / 7d)
  snap.activity = {};
  for (const c of cols) {
    try {
      const [r] = await sql`SELECT
        count(*) FILTER (WHERE ${sql(c)} >= now() - interval '24 hours')::bigint d1,
        count(*) FILTER (WHERE ${sql(c)} >= now() - interval '7 days')::bigint d7
        FROM imported_stores`;
      const d1 = Number(r.d1), d7 = Number(r.d7);
      if (d1 || d7) snap.activity[c] = { last24h: d1, last7d: d7, per_day_7d: Math.round(d7 / 7) };
    } catch { /* non-timestamp column name matched %_at; skip */ }
  }

  // 4. per-machine heartbeats (who's doing what, how fresh)
  try {
    const hb = await sql`SELECT machine, task, last_run, note,
      round(extract(epoch FROM now()-last_run)/60)::int AS mins_ago
      FROM agent_heartbeat ORDER BY machine, last_run DESC`;
    snap.heartbeats = hb.map(h => ({ machine: h.machine, task: h.task, mins_ago: h.mins_ago, note: h.note }));
  } catch (e) { snap.heartbeats_error = e.message; }
} finally { await sql.end(); }

// print a readable summary
console.log(`\n=== pipeline snapshot @ ${snap.captured_at} (host ${snap.host}) ===`);
console.log(`rows: ${snap.totals.rows.toLocaleString()}  published: ${snap.totals.published.toLocaleString()}`);
console.log(`\nactivity (rows touched):`);
console.log("  col".padEnd(34) + "24h".padStart(9) + "7d".padStart(10) + "/day".padStart(9));
for (const [c, v] of Object.entries(snap.activity).sort((a, b) => b[1].last7d - a[1].last7d))
  console.log(`  ${c.padEnd(32)}${String(v.last24h).padStart(9)}${String(v.last7d).padStart(10)}${String(v.per_day_7d).padStart(9)}`);
console.log(`\nheartbeats (per machine, freshest first):`);
let m = "";
for (const h of (snap.heartbeats || [])) {
  if (h.machine !== m) { m = h.machine; console.log(`  [${m}]`); }
  console.log(`    ${h.task.padEnd(20)} ${String(h.mins_ago).padStart(6)}m ago   ${(h.note || "").slice(0, 40)}`);
}
if (outPath) { writeFileSync(outPath, JSON.stringify(snap, null, 2)); console.log(`\nwrote ${outPath}`); }
