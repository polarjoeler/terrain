/**
 * store-work — the slim per-store work table from the 15M scale plan.
 *
 * imported_stores is ~4.5M rows × 150 columns (~4.7GB). Every queue pick, backlog count and
 * freshness check used to read the whole of it; at 15M rows that stops working. store_work keeps
 * ONE narrow row per store (~150 bytes: platform, country, live/published flags, "has X" booleans
 * and each lane's last-touched timestamp, plus the shared priority score), so:
 *   · queues pick their next N stores from a partial index on store_work (instant at any size);
 *   · rollups and daily metrics scan ~600MB instead of ~4.7GB (scripts/build-rollups.mjs).
 *
 * It's kept in step by a trigger on imported_stores (AFTER INSERT/DELETE/UPDATE OF the watched
 * columns), so no lane has to change how it writes. The upsert skips rows whose slim values didn't
 * change, so a write that touches a watched column without changing it costs one index probe.
 * score/market_rank come from store_priority (scripts/build-priority.mjs) and are only ever set by
 * --sync-priority, never by the trigger.
 *
 *   node --env-file=.env.local scripts/store-work.mjs --migrate          # table + function + trigger + indexes (once; prod schema change)
 *   node --env-file=.env.local scripts/store-work.mjs --backfill         # copy existing rows in batches (resumable, safe while live)
 *   node --env-file=.env.local scripts/store-work.mjs --sync-priority    # copy changed score/market_rank from store_priority
 *   node --env-file=.env.local scripts/store-work.mjs --verify [N]       # compare N random rows against imported_stores
 *   node --env-file=.env.local scripts/store-work.mjs --status
 */
import postgres from "postgres";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const num = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? Number(args[i + 1]) : d; };
const BATCH = num("--batch", 50000);

// The columns whose change can move a store's slim row. UPDATE OF fires only when one of these is in
// the statement's SET list, so lanes writing other columns (homepage text, socials, raw…) pay nothing.
const WATCHED = [
  "domain", "country", "platform", "source", "published", "live_status", "activity_tier", "created_at", "discovered_at",
  "technologies", "payments", "payments_source", "email", "contact_email", "contact_name", "plus", "plan_tier",
  "crux_rank", "revenue_ballpark_usd", "launched_at",
  "ai_enriched_at", "deep_enriched_at", "payments_checked_at", "contact_checked_at", "live_checked_at",
  "woo_checkout_at", "render_enriched_at",
];
// Slim columns in order (score/market_rank last; the trigger never writes them).
export const SLIM = [
  "domain", "country", "platform", "source", "published", "live", "dead", "not_store", "created_at", "discovered_at",
  "has_tech", "has_pay", "pay_woo_plugin", "has_email", "has_name", "plus", "has_traffic", "has_rev", "has_launch",
  "ai_at", "deep_at", "pay_at", "contact_at", "live_at", "woo_at", "render_at",
];

export const MIGRATE = [
  `CREATE TABLE IF NOT EXISTS store_work (
     domain text PRIMARY KEY,
     country text NOT NULL DEFAULT '',          -- upper-case ISO2, '' = unknown
     platform text NOT NULL DEFAULT '',         -- lower-case, '' = unknown
     source text,
     published boolean NOT NULL DEFAULT false,
     live boolean NOT NULL DEFAULT true,        -- live_status not dead/migrated
     dead boolean NOT NULL DEFAULT false,       -- live_status = 'dead'
     not_store boolean NOT NULL DEFAULT false,  -- activity_tier = 'not_a_store'
     created_at timestamptz, discovered_at date,
     has_tech boolean NOT NULL DEFAULT false, has_pay boolean NOT NULL DEFAULT false,
     pay_woo_plugin boolean NOT NULL DEFAULT false,
     has_email boolean NOT NULL DEFAULT false, has_name boolean NOT NULL DEFAULT false,
     plus boolean NOT NULL DEFAULT false, has_traffic boolean NOT NULL DEFAULT false,
     has_rev boolean NOT NULL DEFAULT false, has_launch boolean NOT NULL DEFAULT false,
     ai_at timestamptz, deep_at timestamptz, pay_at timestamptz, contact_at timestamptz,
     live_at timestamptz, woo_at timestamptz, render_at timestamptz,
     score real, market_rank int
   ) WITH (fillfactor = 85)`,
  // One place that defines how an imported_stores row maps to its slim row. Used by the trigger and the backfill.
  `CREATE OR REPLACE FUNCTION store_work_of(s imported_stores) RETURNS TABLE (
     domain text, country text, platform text, source text, published boolean, live boolean, dead boolean, not_store boolean,
     created_at timestamptz, discovered_at date, has_tech boolean, has_pay boolean, pay_woo_plugin boolean,
     has_email boolean, has_name boolean, plus boolean, has_traffic boolean, has_rev boolean, has_launch boolean,
     ai_at timestamptz, deep_at timestamptz, pay_at timestamptz, contact_at timestamptz, live_at timestamptz,
     woo_at timestamptz, render_at timestamptz)
   LANGUAGE sql IMMUTABLE AS $$
     SELECT s.domain, upper(coalesce(s.country, '')), lower(coalesce(s.platform, '')), s.source,
       coalesce(s.published, false),
       coalesce(s.live_status, 'active') NOT IN ('dead', 'migrated'),
       s.live_status IS NOT DISTINCT FROM 'dead',
       s.activity_tier IS NOT DISTINCT FROM 'not_a_store',
       s.created_at, s.discovered_at,
       coalesce(s.technologies, '') <> '', coalesce(s.payments, '') <> '',
       s.payments_source IS NOT DISTINCT FROM 'woo_plugin',
       coalesce(nullif(s.email, ''), nullif(s.contact_email, '')) IS NOT NULL,
       coalesce(s.contact_name, '') <> '',
       coalesce(s.plus, false) OR s.plan_tier IS NOT DISTINCT FROM 'plus',
       s.crux_rank IS NOT NULL, s.revenue_ballpark_usd IS NOT NULL, s.launched_at IS NOT NULL,
       s.ai_enriched_at, s.deep_enriched_at, s.payments_checked_at, s.contact_checked_at, s.live_checked_at,
       s.woo_checkout_at, s.render_enriched_at
   $$`,
  `CREATE OR REPLACE FUNCTION store_work_sync() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF TG_OP = 'DELETE' THEN
       DELETE FROM store_work WHERE domain = OLD.domain;
       RETURN NULL;
     END IF;
     IF TG_OP = 'UPDATE' AND NEW.domain IS DISTINCT FROM OLD.domain THEN
       DELETE FROM store_work WHERE domain = OLD.domain;
     END IF;
     INSERT INTO store_work AS w (${SLIM.join(", ")})
       SELECT * FROM store_work_of(NEW)
     ON CONFLICT (domain) DO UPDATE SET ${SLIM.slice(1).map((c) => `${c} = EXCLUDED.${c}`).join(", ")}
     WHERE (${SLIM.slice(1).map((c) => `w.${c}`).join(", ")}) IS DISTINCT FROM (${SLIM.slice(1).map((c) => `EXCLUDED.${c}`).join(", ")});
     RETURN NULL;
   END $$`,
  `DROP TRIGGER IF EXISTS store_work_sync ON imported_stores`,
  `CREATE TRIGGER store_work_sync AFTER INSERT OR DELETE OR UPDATE OF ${WATCHED.join(", ")}
     ON imported_stores FOR EACH ROW EXECUTE FUNCTION store_work_sync()`,
  // Queue indexes. Each is partial on exactly its lane's eligibility, so a pick reads only the
  // stores that lane could take, never the whole table.
  //   payments (checkout_probe: Shopify or unclassified, live, published) — by market, then last probe
  `CREATE INDEX IF NOT EXISTS store_work_pay ON store_work (country, pay_at NULLS FIRST)
     WHERE published AND live AND platform IN ('shopify', '')`,
  //   woo checkout (never probed, gateway unknown or plugin-guessed) — newest first
  `CREATE INDEX IF NOT EXISTS store_work_woo ON store_work (discovered_at DESC NULLS LAST)
     WHERE platform = 'woocommerce' AND live AND woo_at IS NULL AND (NOT has_pay OR pay_woo_plugin)`,
  `CREATE INDEX IF NOT EXISTS store_work_created ON store_work (created_at DESC)`,
];

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 2, onnotice: () => {} });
  try {
    await sql`SET statement_timeout = 600000`;
    await sql`SET lock_timeout = 10000`;
    const exists = !!(await sql`SELECT to_regclass('public.store_work') t`)[0].t;

    if (has("--migrate")) {
      for (const q of MIGRATE) { await sql.unsafe(q); console.log("ok:", q.trim().split("\n")[0].slice(0, 90)); }
      console.log("store_work ready — trigger live. Next: --backfill, then --sync-priority.");
      return;
    }
    if (!exists) {
      if (has("--sync-priority") || has("--verify")) { console.log("store_work not set up yet — nothing to do."); return; }
      console.error("store_work missing — run --migrate first."); process.exit(1);
    }

    if (has("--backfill")) {
      // Walk imported_stores in primary-key order. ON CONFLICT DO NOTHING: any row the trigger has
      // already written is newer than what this batch read, so it wins.
      let cursor = (await sql`SELECT value FROM app_settings WHERE key = 'store-work.backfill'`.catch(() => []))[0]?.value || "";
      let total = 0;
      const t0 = Date.now();
      for (;;) {
        const r = await sql`
          WITH b AS (SELECT s FROM imported_stores s WHERE s.domain > ${cursor} ORDER BY s.domain LIMIT ${BATCH}),
          ins AS (
            INSERT INTO store_work (${sql.unsafe(SLIM.join(", "))}, score, market_rank)
            SELECT w.*, p.account_score, p.market_rank
              FROM b, LATERAL store_work_of(b.s) w
              LEFT JOIN store_priority p ON p.domain = w.domain
            ON CONFLICT (domain) DO NOTHING RETURNING 1)
          SELECT (SELECT max((b.s).domain) FROM b) last, (SELECT count(*) FROM b)::int seen, (SELECT count(*) FROM ins)::int added`;
        const { last, seen, added } = r[0];
        if (!seen) break;
        total += added; cursor = last;
        await sql`INSERT INTO app_settings (key, value) VALUES ('store-work.backfill', ${cursor})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
        process.stdout.write(`\r  backfill: ${total.toLocaleString()} added · at ${cursor.slice(0, 30).padEnd(30)} · ${Math.round((Date.now() - t0) / 1000)}s`);
      }
      console.log(`\nbackfill done: ${total.toLocaleString()} rows added.`);
      await sql`DELETE FROM app_settings WHERE key = 'store-work.backfill'`;
      return;
    }

    if (has("--sync-priority")) {
      const r = await sql`
        UPDATE store_work w SET score = p.account_score, market_rank = p.market_rank
          FROM store_priority p
         WHERE p.domain = w.domain AND (w.score, w.market_rank) IS DISTINCT FROM (p.account_score, p.market_rank)`;
      const c = await sql`
        UPDATE store_work w SET score = NULL, market_rank = NULL
         WHERE w.score IS NOT NULL AND NOT EXISTS (SELECT 1 FROM store_priority p WHERE p.domain = w.domain)`;
      console.log(`sync-priority: ${r.count.toLocaleString()} scores updated, ${c.count.toLocaleString()} cleared.`);
      return;
    }

    if (has("--verify")) {
      const n = num("--verify", 2000);
      const rows = await sql`
        SELECT w.domain FROM (SELECT domain FROM store_work TABLESAMPLE SYSTEM (0.2) LIMIT ${n}) w`;
      const doms = rows.map((r) => r.domain);
      const diff = await sql`
        SELECT x.domain FROM imported_stores s
          CROSS JOIN LATERAL store_work_of(s) x
          JOIN store_work w ON w.domain = x.domain
         WHERE s.domain = ANY(${doms})
           AND (${sql.unsafe(SLIM.slice(1).map((c) => `x.${c}`).join(", "))}) IS DISTINCT FROM (${sql.unsafe(SLIM.slice(1).map((c) => `w.${c}`).join(", "))})`;
      const [{ missing }] = await sql`SELECT count(*)::int missing FROM imported_stores s
        WHERE s.created_at > now() - interval '1 hour' AND NOT EXISTS (SELECT 1 FROM store_work w WHERE w.domain = s.domain)`;
      console.log(`verify: ${doms.length} sampled · ${diff.length} differ${diff.length ? ` (e.g. ${diff.slice(0, 5).map((d) => d.domain).join(", ")})` : ""} · ${missing} stores landed in the last hour without a work row`);
      if (diff.length || missing) process.exitCode = 1;
      return;
    }

    const [s] = await sql`SELECT
        (SELECT reltuples::bigint FROM pg_class WHERE relname = 'store_work') work_rows,
        (SELECT reltuples::bigint FROM pg_class WHERE relname = 'imported_stores') store_rows,
        pg_size_pretty(pg_total_relation_size('store_work')) size,
        (SELECT value FROM app_settings WHERE key = 'store-work.backfill') backfill_cursor`;
    console.log(s);
  } finally {
    await sql.end();
  }
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error("store-work failed:", e.message); process.exit(1); });
