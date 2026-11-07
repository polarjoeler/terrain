/** Saved lists — a named, reusable filter set from the Leads explorer. Personal to a user (keyed on
 *  email), scoped to the org for later sharing. The `view` blob is the Explorer's filter shape
 *  (ExploreInitial), so re-opening a list just re-seeds the Explorer — no separate query language. */
import { db as sharedDb } from "./db";
import { orgKey } from "./profile";

function db() { return sharedDb(); }

// Lock-safe: check information_schema first, only take the exclusive lock to create the table once.
let _ensured: Promise<void> | null = null;
function ensure(sql: ReturnType<typeof db>): Promise<void> {
  return (_ensured ??= (async () => {
    const [r] = await sql<{ one: number }[]>`SELECT 1 one FROM information_schema.tables WHERE table_name = 'saved_list' LIMIT 1`;
    if (r) return;
    await sql.begin(async (t) => {
      await t`SET LOCAL lock_timeout = '3s'`;
      await t`CREATE TABLE IF NOT EXISTS saved_list (
        id bigserial PRIMARY KEY,
        org text NOT NULL,
        email text NOT NULL,
        name text NOT NULL,
        view jsonb NOT NULL DEFAULT '{}',
        match_count int,
        created_at timestamptz NOT NULL DEFAULT now())`;
      await t`CREATE INDEX IF NOT EXISTS idx_saved_list_email ON saved_list (email, created_at DESC)`;
    });
  })().catch((e) => { _ensured = null; throw e; }));
}

const key = (email: string) => email.trim().toLowerCase();
export type SavedView = Record<string, unknown>;
export type SavedList = { id: string; name: string; view: SavedView; count: number | null; createdAt: string };

export async function createList(email: string, name: string, view: SavedView, count: number | null): Promise<string> {
  const sql = db();
  await ensure(sql);
  const e = key(email);
  const nm = name.trim().slice(0, 80) || "Untitled list";
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO saved_list (org, email, name, view, match_count)
    VALUES (${orgKey(e)}, ${e}, ${nm}, ${sql.json(view as Parameters<typeof sql.json>[0])}, ${count ?? null})
    RETURNING id`;
  return String(row.id);
}

export async function listLists(email: string): Promise<SavedList[]> {
  const sql = db();
  try {
    await ensure(sql);
    const rows = await sql<{ id: string; name: string; view: SavedView; match_count: number | null; created_at: string }[]>`
      SELECT id, name, view, match_count, created_at FROM saved_list WHERE email = ${key(email)} ORDER BY created_at DESC LIMIT 100`;
    return rows.map((r) => ({ id: String(r.id), name: r.name, view: r.view ?? {}, count: r.match_count, createdAt: new Date(r.created_at).toISOString() }));
  } catch { return []; }
}

/** A single list, scoped to its owner (so one user can't open another's by id). */
export async function getList(email: string, id: string): Promise<SavedList | null> {
  const sql = db();
  const idNum = Number(id);
  if (!Number.isFinite(idNum)) return null;
  try {
    await ensure(sql);
    const [r] = await sql<{ id: string; name: string; view: SavedView; match_count: number | null; created_at: string }[]>`
      SELECT id, name, view, match_count, created_at FROM saved_list WHERE email = ${key(email)} AND id = ${idNum}`;
    return r ? { id: String(r.id), name: r.name, view: r.view ?? {}, count: r.match_count, createdAt: new Date(r.created_at).toISOString() } : null;
  } catch { return null; }
}

export async function deleteList(email: string, id: string): Promise<void> {
  const sql = db();
  const idNum = Number(id);
  if (!Number.isFinite(idNum)) return;
  await ensure(sql);
  await sql`DELETE FROM saved_list WHERE email = ${key(email)} AND id = ${idNum}`;
}
