/**
 * shop-id-dating — date new Shopify shops from their shop ID, with no extra request to Shopify.
 *
 * Shopify issues shop IDs in sequence, and meta-identify already records them (/meta.json "id") on
 * most new finds. Our own discovery stream calibrates the sequence: the 20th-highest shop ID among a
 * day's finds is the "frontier", the newest shops visible that day. A shop whose ID first falls under
 * the frontier on day D went live (connected its domain and got a certificate) by D. Measured
 * 2026-11-18: from 6 Nov, when global volume reached ~50k+ identified finds a day, the frontier rises
 * cleanly from 112.73B to 113.09B (~33M IDs a day); before that the daily samples are too thin, so
 * older IDs are left undated rather than guessed.
 *
 * Why it matters: of the week's ~695k identified Shopify finds only 0.3% were shops created since
 * September; 83% predate Sep 2025. The CT feed mostly re-surfaces existing shops on certificate
 * renewal, and catalog-enrich (earliest product, the precise date) is throttled to a few thousand a
 * day. This separates genuine launches from re-seen stores for every identified shop, within hours.
 *
 * Writes launched_at = frontier day, launched_source = 'shop_id' — only where a store has no launch
 * date or a 'cert' placeholder. catalog-enrich still replaces it with 'earliest_product' when it
 * reads the catalogue. The app's launch keys exclude only 'cert', so 'shop_id' counts at once.
 *
 *   node --env-file=.env.local scripts/shop-id-dating.mjs --migrate     # create shop_id_frontier (once)
 *   node --env-file=.env.local scripts/shop-id-dating.mjs --dry         # print frontier + what it would date
 *   node --env-file=.env.local scripts/shop-id-dating.mjs               # refresh frontier, stamp dates
 */
import postgres from "postgres";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DRY = has("--dry");
const SINCE = arg("--since", "2026-11-06");   // first day the frontier is trustworthy (see above)
const MIN_N = Number(arg("--min-n", 5000));   // identified Shopify finds needed for a day to count
const RANK = Number(arg("--rank", 20));       // nth-highest ID = frontier (robust to stray IDs)
const SANE_MAX = 200_000_000_000;             // IDs above this are junk (e.g. 23232323323232230)
const RECOMPUTE_DAYS = 7;                     // meta-identify fills shop_id after landing; refresh recent days

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 2, connection: { statement_timeout: 300000, lock_timeout: 10000 } });
  try {
    if (has("--migrate")) {
      await sql`CREATE TABLE IF NOT EXISTS shop_id_frontier (
        day date PRIMARY KEY, id bigint NOT NULL, n int NOT NULL, built_at timestamptz NOT NULL DEFAULT now())`;
      console.log("shop_id_frontier ready.");
      return;
    }
    const ready = (await sql`SELECT to_regclass('public.shop_id_frontier') t`)[0].t;
    if (!ready && !DRY) { console.error("shop_id_frontier missing — run --migrate once."); process.exit(1); }

    // 1. Frontier for each day since SINCE (first run) or the last RECOMPUTE_DAYS.
    const last = ready ? (await sql`SELECT max(day)::text d FROM shop_id_frontier`)[0].d : null;
    const from = last ? (await sql`SELECT greatest(${SINCE}::date, ${last}::date - ${RECOMPUTE_DAYS}::int)::text d`)[0].d : SINCE;
    const days = await sql`
      WITH f AS (
        SELECT (created_at AT TIME ZONE 'UTC')::date AS dd, shop_id,
               row_number() OVER (PARTITION BY (created_at AT TIME ZONE 'UTC')::date ORDER BY shop_id DESC) rk,
               count(*) OVER (PARTITION BY (created_at AT TIME ZONE 'UTC')::date) n
          FROM imported_stores
         WHERE platform = 'Shopify' AND shop_id BETWEEN 1 AND ${SANE_MAX}
           AND created_at >= ${from}::date AND created_at < (now() AT TIME ZONE 'UTC')::date)   -- whole days only
      SELECT dd::text AS day, max(n)::int AS n, max(shop_id) FILTER (WHERE rk = ${RANK}) AS id
        FROM f GROUP BY dd HAVING max(n) >= ${MIN_N} ORDER BY dd`;
    console.log(`frontier days ${from} → yesterday: ${days.length} with ≥${MIN_N.toLocaleString()} identified finds`);
    for (const d of days) console.log(`  ${d.day}  n=${String(d.n).padStart(7)}  #${RANK} id ${(Number(d.id) / 1e9).toFixed(3)}B`);
    if (!DRY && days.length) {
      await sql`INSERT INTO shop_id_frontier (day, id, n)
        SELECT v.d::date, v.i::bigint, v.n::int FROM (VALUES ${sql(days.map((d) => [d.day, String(d.id), d.n]))}) v(d, i, n)
        ON CONFLICT (day) DO UPDATE SET id = EXCLUDED.id, n = EXCLUDED.n, built_at = now()`;
    }

    // 2. Stamp. The frontier is made monotone (running max) so a thin day can't move a date backwards.
    const frontier = DRY
      ? sql`(SELECT v.d::date AS day, max(v.i::bigint) OVER (ORDER BY v.d::date) AS id
               FROM (VALUES ${sql(days.length ? days.map((d) => [d.day, String(d.id)]) : [[SINCE, "0"]])}) v(d, i))`
      : sql`(SELECT day, max(id) OVER (ORDER BY day) AS id FROM shop_id_frontier WHERE day >= ${SINCE}::date)`;
    const [{ lo, hi }] = await sql`SELECT min(id)::text lo, max(id)::text hi FROM ${frontier} f`;
    if (!lo || lo === "0") { console.log("no frontier yet — nothing to date."); return; }
    // IDs at or below the first frontier day predate the window: leave them undated.
    const target = sql`
      SELECT s.domain, (SELECT min(f.day) FROM ${frontier} f WHERE f.id >= s.shop_id) AS day
        FROM imported_stores s
       WHERE s.platform = 'Shopify' AND s.shop_id > ${lo}::bigint AND s.shop_id <= ${hi}::bigint
         AND (s.launched_at IS NULL OR s.launched_source IN ('cert', 'shop_id'))`;
    const preview = await sql`SELECT day::text, count(*)::int n FROM (${target}) t GROUP BY 1 ORDER BY 1`;
    const total = preview.reduce((a, r) => a + r.n, 0);
    console.log(`\nwindow ${(Number(lo) / 1e9).toFixed(3)}B < id ≤ ${(Number(hi) / 1e9).toFixed(3)}B → ${total.toLocaleString()} undated Shopify stores get a launch date${DRY ? " (dry)" : ""}`);
    for (const r of preview) console.log(`  ${r.day}  ${r.n}`);
    if (DRY) return;
    const res = await sql`UPDATE imported_stores s SET launched_at = t.day, launched_source = 'shop_id'
      FROM (${target}) t
      WHERE s.domain = t.domain AND t.day IS NOT NULL
        -- also relabel a 'cert' placeholder that happens to carry the same day (188 rows on the first run)
        AND (s.launched_at IS DISTINCT FROM t.day OR s.launched_source IS DISTINCT FROM 'shop_id')`;
    console.log(`stamped ${res.count.toLocaleString()} rows.`);
  } finally { await sql.end(); }
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error("shop-id-dating failed:", e.message); process.exit(1); });
