/**
 * Apply lib/schema.sql without freezing the hot table.
 *
 * The web app's ensure() helpers memoise schema application in a module-level `_ready`. On Vercel
 * that is per LAMBDA INSTANCE, so every cold start replays the whole file — 86
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, 31 `CREATE INDEX IF NOT EXISTS`, 19
 * `CREATE TABLE IF NOT EXISTS`.
 *
 * None of those are free. `IF NOT EXISTS` is evaluated while HOLDING the lock, not before taking
 * it, so a statement that changes nothing still queues for ACCESS EXCLUSIVE on imported_stores —
 * and because a pending strong lock request blocks every lock requested after it, ordinary reads
 * and writes stall behind it. Measured over 40 days via pg_stat_statements: the schema.sql block
 * ran ~632 times, and its `merchant_name` ALTER alone accounted for 7,133s at ~11.3s per call.
 * That is a multi-second freeze of the hot table triggered by a visitor loading the dashboard.
 *
 * Reading the catalog takes no lock on any of those tables. So: read once, then run only the
 * statements that would actually change something — normally none.
 */

type Runner = { unsafe: (q: string) => Promise<Record<string, string>[]> };

const ADD_COLUMN = /^ALTER\s+TABLE\s+([a-z_]\w*)\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+([a-z_]\w*)/i;
const CREATE_TABLE = /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z_]\w*)/i;
const CREATE_INDEX = /^CREATE\s+INDEX\s+(?:CONCURRENTLY\s+)?IF\s+NOT\s+EXISTS\s+([a-z_]\w*)/i;

/** Split on semicolons that are not inside a string literal or a -- comment. */
export function splitStatements(text: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!quoted && c === "-" && text[i + 1] === "-") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl;
      buf += "\n";
      continue;
    }
    if (c === "'") quoted = !quoted;
    if (c === ";" && !quoted) { out.push(buf.trim()); buf = ""; continue; }
    buf += c;
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

export async function applySchema(db: Runner, ddlText: string): Promise<{ ran: number; skipped: number }> {
  const statements = splitStatements(ddlText);

  // Two sequential catalog reads, NOT Promise.all: fanning out on the small postgres.js pool is
  // what hangs these pages (see the pool-deadlock class).
  const colRows = await db.unsafe(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'",
  );
  const idxRows = await db.unsafe("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'");

  const columns = new Set<string>();
  const tables = new Set<string>();
  for (const r of colRows) {
    tables.add(r.table_name);
    columns.add(`${r.table_name}.${r.column_name}`);
  }
  const indexes = new Set(idxRows.map((r) => r.indexname));

  let ran = 0;
  let skipped = 0;
  for (const stmt of statements) {
    const col = ADD_COLUMN.exec(stmt);
    if (col && columns.has(`${col[1].toLowerCase()}.${col[2].toLowerCase()}`)) { skipped++; continue; }
    const tbl = CREATE_TABLE.exec(stmt);
    if (tbl && tables.has(tbl[1].toLowerCase())) { skipped++; continue; }
    const idx = CREATE_INDEX.exec(stmt);
    if (idx && indexes.has(idx[1].toLowerCase())) { skipped++; continue; }
    await db.unsafe(stmt);
    ran++;
  }
  return { ran, skipped };
}
