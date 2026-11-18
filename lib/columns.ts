/** "Does imported_stores have this column yet?" — asked once, cached.
 *
 *  WHY THIS IS NEEDED. New columns are declared in lib/schema.sql, and the SCRIPTS replay that
 *  file; the web app deliberately stopped doing so (replaying it on every lambda cold start took
 *  ACCESS EXCLUSIVE on the hot table and froze it — see the schema-cold-start fix). So between a
 *  deploy and the next run of a script that replays the schema, the code can reference a column
 *  the database has not got. Postgres fails the WHOLE statement on an unknown column, so without
 *  this guard one new field would take the export, the lead drawer or the admin save down with it.
 *
 *  Cached in module scope, which on serverless means per-instance: 30 minutes once the column is
 *  there, re-asked every minute while it is still missing, so the first instance to see the
 *  migration lands picks it up quickly. Same shape and the same reasoning as sideTables().
 */
import { db } from "./db";

const TTL_PRESENT_MS = 30 * 60_000;
const TTL_MISSING_MS = 60_000;
const cache = new Map<string, { at: number; v: boolean }>();

export async function hasStoreColumn(column: string): Promise<boolean> {
  const hit = cache.get(column);
  if (hit && Date.now() - hit.at < (hit.v ? TTL_PRESENT_MS : TTL_MISSING_MS)) return hit.v;
  try {
    const [r] = await db()<{ ok: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name = 'imported_stores' AND column_name = ${column}) AS ok`;
    const v = Boolean(r?.ok);
    cache.set(column, { at: Date.now(), v });
    return v;
  } catch {
    // A failed lookup must not be read as "the column is gone" — that would silently drop a field
    // that is actually there. Keep whatever we last knew; assume absent only if we never knew.
    return hit?.v ?? false;
  }
}

/** Narrow a wanted column list to the ones that exist. Order is preserved. */
export async function existingStoreColumns(wanted: readonly string[]): Promise<string[]> {
  const present = await Promise.all(wanted.map((c) => hasStoreColumn(c)));
  return wanted.filter((_, i) => present[i]);
}
