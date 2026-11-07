/** push-woo-candidates — hand the Woo candidate feed to the workers THROUGH THE DB.
 *
 *  discover-more (Rex) regenerates ~/shopify-radar/feed/woo-candidates.txt every tick; Lucy's
 *  worker/build_queue.py turns it into a probe queue (minus probe_checked / landed Woo / her log).
 *  The hand-off used to be a git commit + push of that file, which failed silently once Rex lost
 *  its GitHub credentials — Lucy idled on an empty feed for days (2026-11-02 → 11-06). Now Rex
 *  upserts the feed into `woo_candidates` and build_queue reads the table: no git, no files.
 *
 *  Usage (on Rex, from storepulse): node --env-file=.env.local scripts/push-woo-candidates.mjs [--file=PATH]
 */
import postgres from "postgres";
import { readFileSync } from "fs";
import { homedir } from "os";

const FILE = (process.argv.find((a) => a.startsWith("--file=")) || `--file=${homedir()}/shopify-radar/feed/woo-candidates.txt`).split("=")[1];
const CHUNK = 5000;

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 2, idle_timeout: 15,
  connection: { statement_timeout: 60000, idle_in_transaction_session_timeout: 60000, lock_timeout: 5000 } });

try {
  // New, separate table — creating it never touches imported_stores. Guarded so a no-op run issues no DDL.
  const [t] = await sql`SELECT to_regclass('public.woo_candidates') AS t`;
  if (!t.t) {
    await sql`CREATE TABLE woo_candidates (
      domain    text PRIMARY KEY,
      source    text NOT NULL DEFAULT 'discover-more',
      queued_at timestamptz NOT NULL DEFAULT now()
    )`;
    console.log("created table woo_candidates");
  }

  const domains = [...new Set(readFileSync(FILE, "utf8").split(/\s+/).map((d) => d.trim().toLowerCase()).filter((d) => d.includes(".")))];
  let added = 0;
  for (let i = 0; i < domains.length; i += CHUNK) {
    const r = await sql`INSERT INTO woo_candidates (domain)
      SELECT unnest(${domains.slice(i, i + CHUNK)}::text[]) ON CONFLICT (domain) DO NOTHING`;
    added += r.count;
  }
  const [{ n }] = await sql`SELECT count(*)::int n FROM woo_candidates`;
  console.log(`push-woo-candidates: ${domains.length.toLocaleString()} in feed · ${added.toLocaleString()} new · ${n.toLocaleString()} in table`);
} finally {
  await sql.end({ timeout: 5 });
}
