/**
 * store-browse — the slim table behind every Explorer count and facet (lib/browse.ts).
 *
 * The live aggregate scanned imported_stores (6.9GB with indexes, ~150 columns including internal
 * blobs no customer view reads: activity_signals, raw, contact_text, homepage_text) plus a per-row
 * store_dns lookup. That's why one market's filtered view took 44-74s and five markets hit the 120s
 * limit. store_browse is one narrow row per PUBLISHED store worldwide: only the columns the filters
 * and facets read, under their imported_stores names (so the same SQL runs on either table), plus
 * store_dns.email_provider/tools and store_not_trading.reason copied in as dns_email / dns_tools /
 * nt_reason. It covers every country, so opening a market needs no data work.
 *
 * Triggers keep it in step: on imported_stores (insert/delete/update of a listed column; an
 * unpublish deletes the row), on store_dns and on store_not_trading. Writes that change nothing the
 * table holds are skipped, so a no-op write costs one index probe.
 *
 *   node --env-file=.env.local scripts/store-browse.mjs --migrate     # table + functions + 3 triggers + indexes (once; prod schema change)
 *   node --env-file=.env.local scripts/store-browse.mjs --backfill    # copy published rows (resumable, safe while live), then reconcile
 *   node --env-file=.env.local scripts/store-browse.mjs --verify [N]  # compare N sampled stores both ways
 *   node --env-file=.env.local scripts/store-browse.mjs --status
 *
 * Until --backfill finishes (it clears the 'store-browse.backfill' marker), lib/browse.ts keeps
 * reading imported_stores. Rollback: DROP the three store_browse_* triggers and the table; the
 * Explorer falls back on its own.
 *
 * The row page picks its 50 domains here too (filters and sort orders), then reads display columns
 * for just those from imported_stores by primary key.
 *
 * ADDING A COLUMN: if lib/browse.ts starts filtering or counting on a new imported_stores column, add
 * it to COLS below and re-run --migrate (it ALTERs the table and replaces the functions/trigger),
 * then --backfill-column <name>. Until then the browse catches the missing column and answers from
 * imported_stores.
 */
import postgres from "postgres";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const num = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? Number(args[i + 1]) : d; };
const BATCH = num("--batch", 50000);

// Every imported_stores column the browse WHERE (buildWhere), the facet columns (aggColumns), the
// revenue band (lib/fx.ts revExpr: ballpark, estimate, currency, country) and the launch date read.
export const COLS = [
  "domain", "name", "published", "country", "platform", "category", "city", "theme", "activity_tier",
  "hosting_provider", "live_status", "live_checked_at", "payments", "payments_checked_at",
  "shipping_providers", "apps", "plugins", "technologies", "plus", "contact_type", "email",
  "contact_email", "contact_checked_at", "contact_mx_ok", "whatsapp", "migrated_at", "first_product_at",
  "launched_source", "launched_at", "discovered_at", "revenue_ballpark_usd", "estimated_monthly_sales",
  "currency",
  // the row page's sort orders: traffic, catalogue size and the lead-fit score (lib/score.ts)
  "crux_rank", "product_count", "activity_score", "avg_product_price", "instagram", "facebook", "tiktok",
  "instagram_followers", "facebook_followers", "socials",
];
// Copied as an expression rather than the value. The browse only ever asks `socials IS NOT NULL`
// (lib/score.ts), and the jsonb itself is one of the widest columns in imported_stores, so the slim
// table keeps the answer: true when imported_stores.socials is set, NULL otherwise.
const EXPR = { socials: (p) => `CASE WHEN ${p}socials IS NOT NULL THEN true END` };
const TYPE = { socials: "boolean" };
const val = (c, p) => (EXPR[c] ? EXPR[c](p) : `${p}${c}`);
const vals = (xs, p) => xs.map((c) => val(c, p)).join(", ");
const SIDE = ["dns_email", "dns_tools", "nt_reason"];
const ALL = [...COLS, ...SIDE];
const REST = ALL.filter((c) => c !== "domain");
const list = (xs, p = "") => xs.map((c) => p + c).join(", ");
const sideOf = (d) => `(SELECT sd.email_provider FROM store_dns sd WHERE sd.domain = ${d}),
       (SELECT sd.tools FROM store_dns sd WHERE sd.domain = ${d}),
       (SELECT nt.reason FROM store_not_trading nt WHERE nt.domain = ${d})`;

export { vals, SIDE };
export const MIGRATE = [
  // Same column types as imported_stores, by construction.
  `CREATE TABLE IF NOT EXISTS store_browse WITH (fillfactor = 85) AS
     SELECT ${COLS.map((c) => (TYPE[c] ? `${val(c, "s.")}::${TYPE[c]} AS ${c}` : `s.${c}`)).join(", ")}, NULL::text AS dns_email, NULL::text[] AS dns_tools, NULL::text AS nt_reason
     FROM imported_stores s WITH NO DATA`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'store_browse'::regclass AND contype = 'p') THEN
       ALTER TABLE store_browse ADD PRIMARY KEY (domain);
     END IF;
   END $$`,
  // A column added to COLS after the first migrate.
  ...COLS.map((c) => `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'store_browse' AND column_name = '${c}') THEN
       EXECUTE (SELECT format('ALTER TABLE store_browse ADD COLUMN %I %s', '${c}', ${TYPE[c] ? `'${TYPE[c]}'` : "format_type(atttypid, atttypmod)"})
                FROM pg_attribute WHERE attrelid = 'imported_stores'::regclass AND attname = '${c}');
     END IF;
   END $$`),
  `CREATE OR REPLACE FUNCTION store_browse_sync() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF TG_OP = 'DELETE' THEN
       DELETE FROM store_browse WHERE domain = OLD.domain;
       RETURN NULL;
     END IF;
     IF TG_OP = 'UPDATE' AND NEW.domain IS DISTINCT FROM OLD.domain THEN
       DELETE FROM store_browse WHERE domain = OLD.domain;
     END IF;
     IF NOT coalesce(NEW.published, false) THEN
       DELETE FROM store_browse WHERE domain = NEW.domain;
       RETURN NULL;
     END IF;
     INSERT INTO store_browse AS b (${list(ALL)})
       SELECT ${vals(COLS, "NEW.")}, ${sideOf("NEW.domain")}
     ON CONFLICT (domain) DO UPDATE SET ${REST.map((c) => `${c} = EXCLUDED.${c}`).join(", ")}
     WHERE (${list(REST, "b.")}) IS DISTINCT FROM (${list(REST, "EXCLUDED.")});
     RETURN NULL;
   END $$`,
  // CREATE OR REPLACE TRIGGER takes SHARE ROW EXCLUSIVE (waits for writers, never blocks reads);
  // DROP TRIGGER would take ACCESS EXCLUSIVE and freeze the table behind a long scan.
  `CREATE OR REPLACE TRIGGER store_browse_sync AFTER INSERT OR DELETE OR UPDATE OF ${list(COLS)}
     ON imported_stores FOR EACH ROW EXECUTE FUNCTION store_browse_sync()`,
  `CREATE OR REPLACE FUNCTION store_browse_dns_sync() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF TG_OP <> 'INSERT' THEN
       UPDATE store_browse SET dns_email = NULL, dns_tools = NULL
        WHERE domain = OLD.domain AND (TG_OP = 'DELETE' OR NEW.domain IS DISTINCT FROM OLD.domain)
          AND (dns_email IS NOT NULL OR dns_tools IS NOT NULL);
     END IF;
     IF TG_OP <> 'DELETE' THEN
       UPDATE store_browse SET dns_email = NEW.email_provider, dns_tools = NEW.tools
        WHERE domain = NEW.domain AND (dns_email, dns_tools) IS DISTINCT FROM (NEW.email_provider, NEW.tools);
     END IF;
     RETURN NULL;
   END $$`,
  `CREATE OR REPLACE TRIGGER store_browse_dns_sync AFTER INSERT OR DELETE OR UPDATE OF domain, email_provider, tools
     ON store_dns FOR EACH ROW EXECUTE FUNCTION store_browse_dns_sync()`,
  `CREATE OR REPLACE FUNCTION store_browse_nt_sync() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF TG_OP <> 'INSERT' THEN
       UPDATE store_browse SET nt_reason = NULL
        WHERE domain = OLD.domain AND (TG_OP = 'DELETE' OR NEW.domain IS DISTINCT FROM OLD.domain) AND nt_reason IS NOT NULL;
     END IF;
     IF TG_OP <> 'DELETE' THEN
       UPDATE store_browse SET nt_reason = NEW.reason WHERE domain = NEW.domain AND nt_reason IS DISTINCT FROM NEW.reason;
     END IF;
     RETURN NULL;
   END $$`,
  `CREATE OR REPLACE TRIGGER store_browse_nt_sync AFTER INSERT OR DELETE OR UPDATE OF domain, reason
     ON store_not_trading FOR EACH ROW EXECUTE FUNCTION store_browse_nt_sync()`,
  // Every browse filters by market first; the default row order is newest-discovered first.
  `CREATE INDEX IF NOT EXISTS store_browse_country ON store_browse (country, platform)`,
  `CREATE INDEX IF NOT EXISTS store_browse_discovered ON store_browse (discovered_at DESC NULLS LAST)`,
];

// DATABASE_URL is the transaction pooler (:6543), where a bare SET lasts one statement, so every
// timeout is SET LOCAL inside the transaction that needs it.
const inTx = (sql, fn, stmt = "10min", lock = "3s") => sql.begin(async (tx) => {
  await tx.unsafe(`SET LOCAL statement_timeout = '${stmt}'`);
  await tx.unsafe(`SET LOCAL lock_timeout = '${lock}'`);
  return fn(tx);
});
// DDL on a hot table: give up after 3s in the lock queue (writers stall at most 3s), then retry.
async function ddl(sql, q) {
  for (let i = 1; ; i++) {
    try { return await inTx(sql, (tx) => tx.unsafe(q)); }
    catch (e) {
      if (e.code !== "55P03" || i >= 8) throw e;
      console.log(`  lock busy, retry ${i}/7 in ${5 * i}s`); await new Promise((r) => setTimeout(r, 5000 * i));
    }
  }
}

// Walk a table by primary key in batches, saving the cursor in the batch's own transaction.
async function walk(sql, key, label, step) {
  let cursor = (await sql`SELECT value FROM app_settings WHERE key = ${key}`)[0]?.value || "";
  let total = 0; const t0 = Date.now();
  for (;;) {
    const r = await inTx(sql, async (tx) => {
      const [x] = await step(tx, cursor);
      if (x.seen) await tx`INSERT INTO app_settings (key, value) VALUES (${key}, ${x.last})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
      return x;
    });
    if (!r.seen) break;
    total += r.n; cursor = r.last;
    process.stdout.write(`\r  ${label}: ${total.toLocaleString()} · at ${cursor.slice(0, 30).padEnd(30)} · ${Math.round((Date.now() - t0) / 1000)}s`);
  }
  console.log(`\n${label} done: ${total.toLocaleString()}.`);
  return total;
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1, onnotice: () => {} });
  try {
    const exists = !!(await sql`SELECT to_regclass('public.store_browse') t`)[0].t;

    if (has("--migrate")) {
      const [side] = await sql`SELECT to_regclass('public.store_dns') IS NOT NULL d, to_regclass('public.store_not_trading') IS NOT NULL n`;
      if (!side.d || !side.n) { console.error("store_dns and store_not_trading must exist first (the triggers read them)."); process.exit(1); }
      // Mark the backfill pending BEFORE the table appears, so the browse never reads a half-empty one.
      if (!exists) await sql`INSERT INTO app_settings (key, value) VALUES ('store-browse.backfill', '')
        ON CONFLICT (key) DO NOTHING`;
      for (const q of MIGRATE) { await ddl(sql, q); console.log("ok:", q.trim().split("\n")[0].slice(0, 90)); }
      console.log("store_browse ready, triggers live. Next: --backfill.");
      return;
    }
    if (!exists) { console.error("store_browse missing — run --migrate first."); process.exit(1); }

    if (has("--backfill")) {
      // 1. Copy published rows. ON CONFLICT DO NOTHING: a row a trigger already wrote is newer than this read.
      await walk(sql, "store-browse.backfill", "copy", (tx, cursor) => tx`
        WITH b AS (SELECT * FROM imported_stores s WHERE s.domain > ${cursor} ORDER BY s.domain LIMIT ${BATCH}),
        ins AS (
          INSERT INTO store_browse (${sql.unsafe(list(ALL))})
          SELECT ${sql.unsafe(vals(COLS, "b."))}, ${sql.unsafe(sideOf("b.domain"))} FROM b WHERE b.published
          ON CONFLICT (domain) DO NOTHING RETURNING 1)
        SELECT (SELECT max(domain) FROM b) last, (SELECT count(*) FROM b)::int seen, (SELECT count(*) FROM ins)::int n`);
      // 2. Reconcile the races the copy can't see: a store unpublished, or a side-table write landing,
      //    between a batch's read and its insert. Walk store_browse once more.
      await sql`INSERT INTO app_settings (key, value) VALUES ('store-browse.reconcile', '') ON CONFLICT (key) DO NOTHING`;
      await walk(sql, "store-browse.reconcile", "reconcile", (tx, cursor) => tx`
        WITH b AS (SELECT domain FROM store_browse WHERE domain > ${cursor} ORDER BY domain LIMIT ${BATCH}),
        gone AS (
          DELETE FROM store_browse x USING b WHERE x.domain = b.domain
            AND NOT EXISTS (SELECT 1 FROM imported_stores s WHERE s.domain = b.domain AND s.published) RETURNING 1),
        side AS (
          UPDATE store_browse x SET dns_email = v.e, dns_tools = v.t, nt_reason = v.r
            -- only rows the delete above keeps: one statement must not both delete and update a row
            FROM (SELECT b.domain, ${sql.unsafe(sideOf("b.domain"))} FROM b
                   WHERE EXISTS (SELECT 1 FROM imported_stores s WHERE s.domain = b.domain AND s.published)) v(domain, e, t, r)
           WHERE x.domain = v.domain AND (x.dns_email, x.dns_tools, x.nt_reason) IS DISTINCT FROM (v.e, v.t, v.r) RETURNING 1)
        SELECT (SELECT max(domain) FROM b) last, (SELECT count(*) FROM b)::int seen,
               ((SELECT count(*) FROM gone) + (SELECT count(*) FROM side))::int n`);
      await sql`DELETE FROM app_settings WHERE key IN ('store-browse.backfill', 'store-browse.reconcile')`;
      await inTx(sql, (tx) => tx`ANALYZE store_browse`);
      console.log("backfill complete — the Explorer reads store_browse from its next 5-minute check.");
      return;
    }

    if (has("--verify")) {
      const n = num("--verify", 2000);
      const res = await inTx(sql, async (tx) => {
        // imported_stores → store_browse: a sampled published store must have an identical row.
        const src = await tx`SELECT domain FROM imported_stores TABLESAMPLE SYSTEM (0.1) WHERE published LIMIT ${n}`;
        const doms = src.map((r) => r.domain);
        const diff = await tx`
          SELECT s.domain FROM imported_stores s
            LEFT JOIN store_browse b ON b.domain = s.domain
           WHERE s.domain = ANY(${doms}) AND (b.domain IS NULL
             OR (${tx.unsafe(vals(REST.filter((c) => !SIDE.includes(c)), "s."))}) IS DISTINCT FROM (${tx.unsafe(list(REST.filter((c) => !SIDE.includes(c)), "b."))})
             OR (b.dns_email, b.dns_tools, b.nt_reason) IS DISTINCT FROM (${tx.unsafe(sideOf("s.domain"))}))`;
        // store_browse → imported_stores: a sampled row must still be a published store.
        const stale = await tx`
          SELECT b.domain FROM (SELECT domain FROM store_browse TABLESAMPLE SYSTEM (0.1) LIMIT ${n}) b
           WHERE NOT EXISTS (SELECT 1 FROM imported_stores s WHERE s.domain = b.domain AND s.published)`;
        return { checked: doms.length, diff: diff.map((r) => r.domain), stale: stale.map((r) => r.domain) };
      }, "5min");
      console.log(`verify: ${res.checked} published stores sampled · ${res.diff.length} differ or missing${res.diff.length ? ` (e.g. ${res.diff.slice(0, 5).join(", ")})` : ""} · ${res.stale.length} rows no longer published${res.stale.length ? ` (e.g. ${res.stale.slice(0, 5).join(", ")})` : ""}`);
      if (res.diff.length || res.stale.length) process.exitCode = 1;
      return;
    }

    const [s] = await sql`SELECT
        (SELECT reltuples::bigint FROM pg_class WHERE relname = 'store_browse') rows,
        pg_size_pretty(pg_total_relation_size('store_browse')) size,
        (SELECT value FROM app_settings WHERE key = 'store-browse.backfill') backfill_cursor,
        (SELECT value FROM app_settings WHERE key = 'store-browse.reconcile') reconcile_cursor`;
    console.log(s);
  } finally {
    await sql.end();
  }
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error("store-browse failed:", e.message); process.exit(1); });
