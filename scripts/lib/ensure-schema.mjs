/**
 * Idempotent column checks that don't freeze the table.
 *
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` reads as free, and isn't: IF NOT EXISTS is evaluated
 * while HOLDING ACCESS EXCLUSIVE, not before taking it. On imported_stores, where long enrichment
 * scans run continuously, that lock request has to queue — and because a pending strong lock
 * request blocks every lock requested after it, ordinary reads and writes stall behind a statement
 * that changes nothing. That is how a startup schema check freezes the hot table.
 *
 * Measured with pg_stat_statements (2026-11-03, track_utility on): 66,216 such calls across the
 * fleet totalling 46,762s — 13 hours — of lock-queue occupancy.
 *
 * Reading information_schema takes no lock on the table at all. Check first, ALTER only what is
 * genuinely missing — which, after the first run, is nothing. Real migrations still run.
 *
 * SCOPE. This module is for a script that knows its own columns as a literal map — the common case
 * in the lanes. A script that applies lib/schema.sql as TEXT wants `applySchema` from
 * lib/ensure-schema.ts instead: it guards CREATE TABLE and CREATE INDEX as well as ADD COLUMN, and
 * owns the only statement splitter in the repo. An `.mjs` script imports it directly, the way
 * scripts/build-priority.mjs imports lib/fx.ts. Do NOT grow a second splitter or a second guard
 * here — two write paths that must agree are how the contact and LinkedIn lanes drifted apart.
 */

async function presentColumns(sql, tables) {
  const rows = await sql`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ANY(${tables})`;
  const byTable = new Map();
  for (const r of rows) {
    if (!byTable.has(r.table_name)) byTable.set(r.table_name, new Set());
    byTable.get(r.table_name).add(r.column_name);
  }
  return byTable;
}

/**
 * ALTER only the columns of `table` that are actually absent.
 * `columns` maps column name -> SQL type. Returns the number added, so a caller can log a real
 * migration and stay silent on the overwhelmingly common no-op path.
 */
export async function ensureColumns(sql, table, columns) {
  const have = (await presentColumns(sql, [table])).get(table) ?? new Set();
  const missing = Object.keys(columns).filter((c) => !have.has(c.toLowerCase()));
  for (const col of missing) {
    // col/type come from the caller's own literal object, never from external input.
    await sql.unsafe(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${columns[col]}`);
  }
  return missing.length;
}
