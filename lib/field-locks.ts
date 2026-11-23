/** Field locks: an admin edit that sticks.
 *
 *  imported_stores has a dozen-plus writers (payment probes, liveness, deep-enrich, render-enrich,
 *  reconcile, contact lanes...). Teaching each one to respect a hand edit means touching all of them
 *  and hoping none is missed. So the rule lives in the database instead: `locked_fields` lists the
 *  columns an admin set by hand, and a BEFORE UPDATE trigger puts those columns back to their old
 *  value on any update that isn't the admin edit itself. The admin edit marks itself with
 *  `SET LOCAL terrain.manual_edit = 'on'` inside its transaction (app/admin/explore/store-edit-action.ts).
 *
 *  Unlocked rows pay nothing: the trigger is `WHEN (OLD.locked_fields IS NOT NULL)`, so the function
 *  never even runs for the millions of rows nobody has edited.
 *
 *    npx tsx --env-file=.env.local scripts/field-locks.ts --migrate   # create the column + trigger (once)
 *    npx tsx --env-file=.env.local scripts/field-locks.ts             # status: is it installed, how many locked rows
 */
import { db } from "./db";

/** Columns that move together with an edited column. Locking only the edited column would let a lane
 *  rewrite its companion (e.g. launched_source next to a hand-set launched_at) and leave the row
 *  contradicting itself. */
export const LOCK_COMPANIONS: Record<string, string[]> = {
  country: ["country_source"],
  launched_at: ["launched_source"],
  payments: ["payments_source"],
  estimated_monthly_sales: [
    "revenue_ballpark_usd", "revenue_ballpark_zar", "revenue_low_usd", "revenue_high_usd",
    "revenue_low_zar", "revenue_high_zar", "revenue_band", "revenue_model", "revenue_confidence",
  ],
  contact_name: ["contact_source", "contact_type"],
  contact_email: ["contact_source", "contact_type"],
  contact_role: ["contact_source"],
  contact_phone: ["contact_source"],
  whatsapp: ["contact_source"],
  contact_form_url: ["contact_source"],
  linkedin: ["contact_source"],
};

/** The columns a lock on `field` covers: the field itself plus its companions. */
export function lockSet(fields: string[]): string[] {
  const out = new Set<string>();
  for (const f of fields) {
    out.add(f);
    for (const c of LOCK_COMPANIONS[f] ?? []) out.add(c);
  }
  out.delete("domain");
  out.delete("locked_fields");
  return [...out].sort();
}

let _has: { at: number; v: boolean } | null = null;
/** Has `--migrate` run? Re-checked every minute while missing, every 30 min once present. Any error
 *  reads as "not installed", so an edit falls back to a plain (unlocked) save instead of failing. */
export async function hasFieldLocks(): Promise<boolean> {
  if (_has && Date.now() - _has.at < (_has.v ? 30 : 1) * 60_000) return _has.v;
  try {
    const [r] = await db()<{ ok: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name = 'imported_stores' AND column_name = 'locked_fields') AS ok`;
    _has = { at: Date.now(), v: Boolean(r?.ok) };
  } catch {
    return _has?.v ?? false;
  }
  return _has.v;
}

const TRIGGER_FN = `
CREATE OR REPLACE FUNCTION keep_locked_fields() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  -- The admin edit itself (store-edit-action.ts) may change anything, including the lock list.
  IF current_setting('terrain.manual_edit', true) = 'on' THEN
    RETURN NEW;
  END IF;
  -- Everyone else: every locked column, and the lock list itself, keeps its old value. Names in the
  -- list that aren't columns are ignored by jsonb_populate_record.
  NEW := jsonb_populate_record(NEW, (
    SELECT jsonb_object_agg(k, to_jsonb(OLD) -> k)
    FROM unnest(OLD.locked_fields || ARRAY['locked_fields']) AS k));
  RETURN NEW;
END
$fn$`;

/** Run one DDL statement with a short lock wait, retrying while busy writers hold the table. ADD
 *  COLUMN and CREATE TRIGGER both need a table lock, and imported_stores is written constantly, so a
 *  plain statement can queue behind a long UPDATE and block every reader behind it. */
async function ddl(stmt: string, log: (m: string) => void): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await db().begin(async (q) => {
        await q`SET LOCAL lock_timeout = '3s'`;
        await q.unsafe(stmt);
      });
      return;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "55P03" || attempt >= 20) throw e;   // 55P03 = lock_not_available
      log(`table busy, retrying (${attempt})`);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}

/** Create the column, the trigger function and the trigger. Safe to re-run. Prod schema change:
 *  Joel runs it, once. */
export async function migrateFieldLocks(log: (m: string) => void = () => {}): Promise<void> {
  // Check the catalog first: ALTER ... ADD COLUMN IF NOT EXISTS still takes ACCESS EXCLUSIVE even
  // when the column is already there.
  _has = null;
  if (!(await hasFieldLocks())) {
    await ddl(`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS locked_fields text[]`, log);
    log("added imported_stores.locked_fields");
  }
  await db().unsafe(TRIGGER_FN);
  log("trigger function ready");
  await ddl(`CREATE OR REPLACE TRIGGER keep_locked_fields BEFORE UPDATE ON imported_stores
    FOR EACH ROW WHEN (OLD.locked_fields IS NOT NULL) EXECUTE FUNCTION keep_locked_fields()`, log);
  log("trigger keep_locked_fields ready");
  _has = null;
}
