/** Japan-scoped read model — everything the isolated /jp locale needs, locked to country='JP'
 *  so it never bleeds into the Africa experience. Purpose-built (not the big English insights
 *  view) so the demo surfaces stay clean and fully bilingual. */
import postgres from "postgres";

let _sql: ReturnType<typeof postgres> | null = null;
function db() {
  if (!_sql) _sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 3, idle_timeout: 20 });
  return _sql;
}
const LIVE = () => db()`published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated')) AND UPPER(country)='JP'`;

export type NameN = { label: string; n: number };
export type JpStats = {
  total: number; dated: number; paidPct: number;
  byPlatform: NameN[];      // store count per platform
  byYear: { year: string; n: number }[];   // launches by year (cumulative-friendly)
  topPayments: NameN[];     // most-common payment providers
  newThisQuarter: number;
};

export async function jpStats(): Promise<JpStats> {
  const sql = db();
  const LAUNCH = sql`COALESCE((CASE WHEN first_product_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN left(first_product_at,10)::date END), launched_at)`;
  const [tot] = await sql<{ total: number; dated: number; paid: number; nq: number }[]>`
    SELECT count(*)::int total,
      count(*) FILTER (WHERE ${LAUNCH} IS NOT NULL)::int dated,
      count(*) FILTER (WHERE payments IS NOT NULL AND payments <> '')::int paid,
      count(*) FILTER (WHERE ${LAUNCH} >= date_trunc('quarter', now()))::int nq
    FROM imported_stores WHERE ${LIVE()}`;
  const plat = await sql<NameN[]>`SELECT COALESCE(NULLIF(platform,''),'—') label, count(*)::int n
    FROM imported_stores WHERE ${LIVE()} GROUP BY 1 ORDER BY n DESC`;
  const yr = await sql<{ year: string; n: number }[]>`
    SELECT to_char(${LAUNCH}, 'YYYY') year, count(*)::int n
    FROM imported_stores WHERE ${LIVE()} AND ${LAUNCH} IS NOT NULL AND ${LAUNCH} >= '2013-01-01'
    GROUP BY 1 ORDER BY 1`;
  const pay = await sql<NameN[]>`SELECT label, count(*)::int n FROM (
      SELECT trim(unnest(string_to_array(payments, ';'))) label FROM imported_stores
      WHERE ${LIVE()} AND payments IS NOT NULL AND payments <> ''
    ) x WHERE label <> '' GROUP BY 1 ORDER BY n DESC LIMIT 8`;
  return {
    total: Number(tot.total), dated: Number(tot.dated),
    paidPct: tot.total ? Math.round((100 * tot.paid) / tot.total) : 0,
    byPlatform: plat.map((r) => ({ label: r.label, n: Number(r.n) })),
    byYear: yr.map((r) => ({ year: r.year, n: Number(r.n) })),
    topPayments: pay.map((r) => ({ label: r.label, n: Number(r.n) })),
    newThisQuarter: Number(tot.nq),
  };
}

export type JpLead = {
  domain: string; name: string; platform: string | null; launched: string | null;
  payments: string[]; city: string | null; category: string | null; productCount: number | null;
};
export async function jpLeads(limit = 200): Promise<JpLead[]> {
  const sql = db();
  const LAUNCH = sql`COALESCE((CASE WHEN first_product_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN left(first_product_at,10)::date END), launched_at)`;
  const rows = await sql`
    SELECT domain, name, platform, ${LAUNCH} AS launched, payments, city, category, product_count
    FROM imported_stores WHERE ${LIVE()}
    ORDER BY ${LAUNCH} DESC NULLS LAST, estimated_monthly_sales DESC NULLS LAST
    LIMIT ${limit}`;
  return rows.map((r) => ({
    domain: r.domain, name: r.name ?? r.domain, platform: r.platform,
    launched: r.launched ? new Date(r.launched).toISOString().slice(0, 10) : null,
    payments: r.payments ? String(r.payments).split(";").map((s) => s.trim()).filter(Boolean).slice(0, 4) : [],
    city: r.city, category: r.category, productCount: r.product_count,
  }));
}
