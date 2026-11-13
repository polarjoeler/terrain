/**
 * build-rollups — the summary tables from the 15M scale plan, built off the slim store_work table
 * (scripts/store-work.mjs) so one pass reads ~600MB instead of the 4.7GB store table.
 *
 *   store_rollup   (country, platform) → m jsonb       — rebuilt every run (hourly). Backlog counts,
 *                  coverage, rolling-24h flows and each lane's last write. health-check, payment-queue
 *                  and the ops pages read this instead of counting the whole store table themselves.
 *   metrics_daily  (day, country, platform) → m jsonb  — one row per SAST day, written by the first run
 *                  after midnight SAST for the day that just ended. The history behind the HQ Metrics tab
 *                  and, later, in-app trend charts. Never rewritten once a day is closed.
 *
 *   node --env-file=.env.local scripts/build-rollups.mjs --migrate             # create both tables (once)
 *   node --env-file=.env.local scripts/build-rollups.mjs                       # rollup (+ yesterday's metrics if missing)
 *   node --env-file=.env.local scripts/build-rollups.mjs --backfill-days 90    # discovery history from created_at
 *   node --env-file=.env.local scripts/build-rollups.mjs --dry-run             # print, write nothing
 *
 * Metric keys (all counts; "live" = published, not dead/migrated, not labelled not_a_store):
 *   stock   stores published live dead not_store · tech pay email named ai deep traffic rev launch plus (of live)
 *   flows   found found_own found_bought ai_n deep_n pay_n contact_n live_n woo_n render_n (stores touched in the window)
 *   backlog todo_pay todo_woo todo_deep todo_contact todo_ai
 *   last    last_found last_ai last_deep last_pay last_contact last_live last_woo last_render (ISO, rollup only)
 * Flows count stores whose lane timestamp falls in the window, i.e. the store's LAST touch. Closing a
 * day at 00:05 keeps that exact for the day just ended; re-probes of the same store count once.
 */
import postgres from "postgres";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const num = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? Number(args[i + 1]) : d; };
const DRY = has("--dry-run");
const TZ = "Africa/Johannesburg";
// Bought lists (benchmark data, never resold) vs stores we found ourselves.
const BOUGHT = ["storecensus"];   // plus storeleads-* and builtwith* (LIKE below)

const MIGRATE = [
  `CREATE TABLE IF NOT EXISTS store_rollup (
     country text NOT NULL, platform text NOT NULL, m jsonb NOT NULL, built_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (country, platform))`,
  `CREATE TABLE IF NOT EXISTS metrics_daily (
     day date NOT NULL, country text NOT NULL, platform text NOT NULL, m jsonb NOT NULL,
     built_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (day, country, platform))`,
];

// One aggregate over store_work. `from`/`to` bound the flow window. Stock and backlog are "now".
export function aggregate(sql, from, to) {
  const W = (col) => sql`count(*) FILTER (WHERE ${sql(col)} >= ${from} AND ${sql(col)} < ${to})::int`;
  const LIVE = sql`published AND live AND NOT not_store`;
  return sql`
    SELECT country, platform, jsonb_strip_nulls(jsonb_build_object(
      'stores', count(*)::int,
      'published', count(*) FILTER (WHERE published)::int,
      'live', count(*) FILTER (WHERE ${LIVE})::int,
      'dead', count(*) FILTER (WHERE dead)::int,
      'not_store', count(*) FILTER (WHERE not_store)::int,
      'tech', count(*) FILTER (WHERE ${LIVE} AND has_tech)::int,
      'pay', count(*) FILTER (WHERE ${LIVE} AND has_pay)::int,
      'email', count(*) FILTER (WHERE ${LIVE} AND has_email)::int,
      'named', count(*) FILTER (WHERE ${LIVE} AND has_name)::int,
      'ai', count(*) FILTER (WHERE ${LIVE} AND ai_at IS NOT NULL)::int,
      'deep', count(*) FILTER (WHERE ${LIVE} AND deep_at IS NOT NULL)::int,
      'traffic', count(*) FILTER (WHERE ${LIVE} AND has_traffic)::int,
      'rev', count(*) FILTER (WHERE ${LIVE} AND has_rev)::int,
      'launch', count(*) FILTER (WHERE ${LIVE} AND has_launch)::int,
      'plus', count(*) FILTER (WHERE ${LIVE} AND plus)::int,
      'found', ${W("created_at")},
      'found_bought', count(*) FILTER (WHERE created_at >= ${from} AND created_at < ${to} AND (source = ANY(${BOUGHT}) OR source LIKE 'storeleads%' OR source LIKE 'builtwith%'))::int,
      'ai_n', ${W("ai_at")}, 'deep_n', ${W("deep_at")}, 'pay_n', ${W("pay_at")}, 'contact_n', ${W("contact_at")},
      'live_n', ${W("live_at")}, 'woo_n', ${W("woo_at")}, 'render_n', ${W("render_at")},
      -- backlogs, matching each lane's own selection
      'todo_pay', count(*) FILTER (WHERE published AND live AND platform IN ('shopify', '') AND NOT has_pay AND pay_at IS NULL)::int,
      'todo_woo', count(*) FILTER (WHERE platform = 'woocommerce' AND live AND woo_at IS NULL AND (NOT has_pay OR pay_woo_plugin))::int,
      'todo_deep', count(*) FILTER (WHERE published AND live AND platform <> '' AND deep_at IS NULL)::int,
      'todo_contact', count(*) FILTER (WHERE published AND live AND contact_at IS NULL AND country <> 'JP')::int,
      'todo_ai', count(*) FILTER (WHERE published AND ai_at IS NULL)::int,
      'last_found', max(created_at), 'last_ai', max(ai_at), 'last_deep', max(deep_at), 'last_pay', max(pay_at),
      'last_contact', max(contact_at), 'last_live', max(live_at), 'last_woo', max(woo_at), 'last_render', max(render_at)
    )) m
    FROM store_work GROUP BY country, platform`;
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 2, onnotice: () => {} });
  try {
    await sql`SET statement_timeout = 600000`;
    await sql`SET lock_timeout = 10000`;
    if (has("--migrate")) {
      for (const q of MIGRATE) await sql.unsafe(q);
      console.log("store_rollup + metrics_daily ready.");
      return;
    }
    const ok = (await sql`SELECT to_regclass('public.store_work') w, to_regclass('public.store_rollup') r, to_regclass('public.metrics_daily') d`)[0];
    if (!ok.w || !ok.r || !ok.d) { console.error("missing store_work / store_rollup / metrics_daily — run the --migrate steps first."); process.exit(1); }
    if ((await sql`SELECT 1 FROM app_settings WHERE key = 'store-work.backfill'`).length) {
      console.log("store_work backfill still running — rollups would undercount; skipping."); return;
    }

    if (has("--backfill-days")) {
      // Discovery history only: created_at is a store's first insert, so per-day counts are exact.
      // Every other lane timestamp is a last touch, so its history can't be rebuilt — it accrues daily.
      const days = num("--backfill-days", 90);
      const rows = await sql`
        SELECT (created_at AT TIME ZONE ${TZ})::date AS day, country, platform,
          jsonb_build_object('found', count(*)::int,
            'found_bought', count(*) FILTER (WHERE source = ANY(${BOUGHT}) OR source LIKE 'storeleads%')::int) m
          FROM store_work
         WHERE created_at >= (date_trunc('day', now() AT TIME ZONE ${TZ}) - ${days} * interval '1 day') AT TIME ZONE ${TZ}
           AND created_at < date_trunc('day', now() AT TIME ZONE ${TZ}) AT TIME ZONE ${TZ}
         GROUP BY 1, 2, 3`;
      console.log(`backfill: ${rows.length.toLocaleString()} day×country×platform cells over ${days} days`);
      if (!DRY) {
        for (let i = 0; i < rows.length; i += 2000) {
          const chunk = rows.slice(i, i + 2000).map((r) => [r.day.toISOString().slice(0, 10), r.country, r.platform, JSON.stringify(r.m)]);
          // Only fills discovery keys into days that have no full snapshot; a closed day is never overwritten.
          await sql`INSERT INTO metrics_daily (day, country, platform, m)
            SELECT v.d::date, v.c, v.p, v.m::jsonb FROM (VALUES ${sql(chunk)}) v(d, c, p, m)
            ON CONFLICT (day, country, platform) DO UPDATE SET m = metrics_daily.m || EXCLUDED.m
              WHERE NOT (metrics_daily.m ? 'live')`;
        }
      }
      return;
    }

    // 1. Rolling rollup (last 24h flows).
    const t0 = Date.now();
    const roll = await aggregate(sql, sql`now() - interval '24 hours'`, sql`now()`);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const sum = (k) => roll.reduce((s, r) => s + (r.m[k] || 0), 0);
    console.log(`rollup: ${roll.length} cells in ${secs}s · ${sum("stores").toLocaleString()} stores · ${sum("live").toLocaleString()} live · found 24h ${sum("found").toLocaleString()} · pay checks 24h ${sum("pay_n").toLocaleString()} · ai 24h ${sum("ai_n").toLocaleString()}`);
    if (!DRY) {
      await sql.begin(async (tx) => {
        await tx`DELETE FROM store_rollup`;
        for (let i = 0; i < roll.length; i += 2000)
          await tx`INSERT INTO store_rollup (country, platform, m)
            SELECT v.c, v.p, v.m::jsonb FROM (VALUES ${tx(roll.slice(i, i + 2000).map((r) => [r.country, r.platform, JSON.stringify(r.m)]))}) v(c, p, m)`;
        await tx`INSERT INTO app_settings (key, value) VALUES ('rollups.built', ${JSON.stringify({ at: new Date().toISOString(), cells: roll.length, secs: Number(secs) })})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
      });
    }

    // 2. Close yesterday (SAST) once: the first run after midnight writes it; later runs see it exists.
    const [{ y }] = await sql`SELECT ((now() AT TIME ZONE ${TZ})::date - 1)::text y`;
    const closed = (await sql`SELECT 1 FROM metrics_daily WHERE day = ${y}::date AND m ? 'live' LIMIT 1`).length > 0;
    if (!closed || has("--force-day")) {
      const from = sql`(${y}::date)::timestamp AT TIME ZONE ${TZ}`;
      const to = sql`(${y}::date + 1)::timestamp AT TIME ZONE ${TZ}`;
      const day = await aggregate(sql, from, to);
      for (const r of day) for (const k of Object.keys(r.m)) if (k.startsWith("last_")) delete r.m[k];
      console.log(`metrics_daily ${y}: ${day.length} cells · found ${day.reduce((s, r) => s + (r.m.found || 0), 0).toLocaleString()}`);
      if (!DRY) {
        await sql.begin(async (tx) => {
          await tx`DELETE FROM metrics_daily WHERE day = ${y}::date`;
          for (let i = 0; i < day.length; i += 2000)
            await tx`INSERT INTO metrics_daily (day, country, platform, m)
              SELECT ${y}::date, v.c, v.p, v.m::jsonb FROM (VALUES ${tx(day.slice(i, i + 2000).map((r) => [r.country, r.platform, JSON.stringify(r.m)]))}) v(c, p, m)`;
        });
      }
    }
  } finally {
    await sql.end();
  }
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error("build-rollups failed:", e.message); process.exit(1); });
