/**
 * Field locks — install or inspect the rule that keeps admin edits from being overwritten by the
 * crawlers. See lib/field-locks.ts.
 *
 *   npx tsx --env-file=.env.local scripts/field-locks.ts --migrate   # create column + trigger (once; prod schema change)
 *   npx tsx --env-file=.env.local scripts/field-locks.ts             # status only, read-only
 */
import { hasFieldLocks, migrateFieldLocks } from "../lib/field-locks.ts";
import { db } from "../lib/db";

async function main() {
  if (process.argv.includes("--migrate")) await migrateFieldLocks((m) => console.log("  " + m));
  const installed = await hasFieldLocks();
  if (!installed) {
    console.log("field locks: NOT installed (run with --migrate). Admin edits save, but crawlers can overwrite them.");
  } else {
    const [t] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'imported_stores'::regclass AND tgname = 'keep_locked_fields'`;
    const rows = await db()<{ f: string; n: number }[]>`
      SELECT f, count(*)::int AS n FROM imported_stores, unnest(locked_fields) AS f
      WHERE locked_fields IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`;
    console.log(`field locks: installed · trigger ${t?.n ? "present" : "MISSING (re-run --migrate)"}`);
    console.log(rows.length ? rows.map((r) => `  ${r.f}: ${r.n}`).join("\n") : "  no locked fields yet");
  }
  await db().end();
}
main().catch(async (e) => { console.error("field-locks failed:", e.message); await db().end().catch(() => {}); process.exit(1); });
