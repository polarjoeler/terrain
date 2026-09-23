/** Server-side browse: filtering, paging and facet counts computed in SQL.
 *
 *  Replaces the "load the top 20,000 rows by revenue and filter them in the
 *  browser" model, which was wrong in a way that mattered: new stores have no
 *  revenue yet, so `ORDER BY estimated_monthly_sales DESC NULLS LAST LIMIT 20000`
 *  cut exactly the stores Terrain exists to surface. 329 stores launched in the
 *  last week; 4 survived the cut. Kenya has 2,450 stores; 592 survived. Every
 *  count shown was a count of the surviving slice, not of the data.
 *
 *  Counts here come from aggregates over the whole table, so they are true
 *  regardless of how many rows the page happens to be showing.
 *
 *  NOTE: queries run SEQUENTIALLY, never Promise.all — the postgres.js pool is
 *  max:3 and fanning aggregates out in parallel deadlocks the page.
 */
import postgres from "postgres";
import { usdSqlExpr, bandSqlExpr, revenueBand, type RevenueBand } from "./fx.ts";

let _sql: ReturnType<typeof postgres> | null = null;
function db() {
  if (!_sql) _sql = postgres(process.env.DATABASE_URL!, { max: 3, idle_timeout: 20 });
  return _sql;
}

const VISIBLE_MARKETS = ["ZA", "KE", "NG"] as const;
const HIDDEN_PLATFORMS = ["wix", "adobe_commerce", "magento"];

export type SortKey = "score" | "sales" | "name" | "launched" | "discovered";

export type BrowseFilters = {
  q?: string;
  country?: string[]; platform?: string[]; category?: string[];
  band?: string[]; theme?: string[]; city?: string[];
  payment?: string[]; shipping?: string[];
  plus?: boolean; hasEmail?: boolean; noPayment?: boolean;
  tier?: "top100" | "top500";
  launchedDays?: number;      // launched within N days
  discoveredDays?: number;    // we first tracked it within N days
  sort?: SortKey;
  limit?: number; offset?: number;
};

/** Lean row: what the table renders and nothing else. Contact details, socials,
 *  catalog depth, apps and hosting load from the drawer on click — they were
 *  ~40% of the old payload and none of them are table columns. `hasEmail` is a
 *  boolean rather than the address, so 6,000 contact addresses stop being
 *  broadcast to every browser session. */
export type BrowseRow = {
  domain: string; name: string | null; category: string | null;
  country: string | null; city: string | null;
  platform: string | null; theme: string | null;
  plus: boolean; hasEmail: boolean;
  estMonthlySales: number | null; band: RevenueBand;
  launchedAt: string | null; discoveredAt: string | null;
  top100: boolean; top500: boolean;
  score: number;
};

export type Facet = { value: string; count: number }[];

export type BrowseResult = {
  rows: BrowseRow[];
  total: number;              // true count for the current filters
  universe: number;           // true count with no filters at all
  facets: {
    country: Facet; platform: Facet; band: Facet;
    category: Facet; city: Facet; theme: Facet;
  };
  recency: {
    launched: Record<number, number>;
    discovered: Record<number, number>;
  };
};

const d = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 10) : null);

function buildWhere(f: BrowseFilters) {
  const sql = db();
  const launchExpr = sql.unsafe(
    `COALESCE((CASE WHEN first_product_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN left(first_product_at,10)::date END), launched_at)`,
  );
  const conds = [
    sql`published`,
    sql`(live_status IS NULL OR live_status NOT IN ('dead','migrated'))`,
    sql`country = ANY(${[...VISIBLE_MARKETS]})`,
    sql`(platform IS NULL OR lower(platform) <> ALL(${HIDDEN_PLATFORMS}))`,
    // Parked Woo installs are captured elsewhere but aren't leads.
    sql`(lower(platform) IS DISTINCT FROM 'woocommerce' OR activity_tier IS DISTINCT FROM 'not_a_store')`,
  ];
  if (f.q) conds.push(sql`(domain ILIKE ${"%" + f.q + "%"} OR name ILIKE ${"%" + f.q + "%"})`);
  if (f.country?.length) conds.push(sql`country = ANY(${f.country})`);
  if (f.platform?.length) conds.push(sql`platform = ANY(${f.platform})`);
  if (f.category?.length) conds.push(sql`category = ANY(${f.category})`);
  if (f.city?.length) conds.push(sql`city = ANY(${f.city})`);
  if (f.theme?.length) conds.push(sql`btrim(theme) ILIKE ANY(${f.theme})`);
  if (f.band?.length) conds.push(sql`${sql.unsafe(bandSqlExpr())} = ANY(${f.band})`);
  if (f.payment?.length) conds.push(sql`payments ILIKE ANY(${f.payment.map((p) => `%${p}%`)})`);
  if (f.shipping?.length) conds.push(sql`shipping_providers ILIKE ANY(${f.shipping.map((s) => `%${s}%`)})`);
  if (f.plus) conds.push(sql`plus`);
  if (f.hasEmail) conds.push(sql`email IS NOT NULL AND email <> ''`);
  if (f.noPayment) conds.push(sql`payments_checked_at IS NOT NULL AND (payments IS NULL OR payments = '')`);
  if (f.tier) conds.push(sql`domain IN (SELECT domain FROM store_tags WHERE tag = ${f.tier === "top100" ? "top-100" : "top-500"})`);
  if (f.launchedDays) conds.push(sql`${launchExpr} >= CURRENT_DATE - ${f.launchedDays}::int`);
  if (f.discoveredDays) conds.push(sql`discovered_at >= CURRENT_DATE - ${f.discoveredDays}::int`);
  return conds.reduce((a, c) => sql`${a} AND ${c}`);
}

const ORDER: Record<SortKey, string> = {
  sales: "estimated_monthly_sales DESC NULLS LAST",
  name: "COALESCE(name, domain) ASC",
  launched: "launched_on DESC NULLS LAST",
  discovered: "discovered_at DESC NULLS LAST",
  score: "estimated_monthly_sales DESC NULLS LAST", // score is derived; revenue is its dominant term
};

/** Unfiltered total. Identical for every request, so compute it once. */
let _universe: { at: number; n: number } | null = null;
async function universeCount(): Promise<number> {
  if (_universe && Date.now() - _universe.at < 5 * 60_000) return _universe.n;
  const sql = db();
  const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int n FROM imported_stores WHERE ${buildWhere({})}`;
  _universe = { at: Date.now(), n };
  return n;
}

export async function browseQuery(f: BrowseFilters = {}): Promise<BrowseResult> {
  const sql = db();
  const where = buildWhere(f);
  const usd = sql.unsafe(usdSqlExpr());
  const band = sql.unsafe(bandSqlExpr());
  const launchSel = sql.unsafe(
    `COALESCE((CASE WHEN first_product_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN left(first_product_at,10)::date END), launched_at) AS launched_on`,
  );
  const limit = Math.min(f.limit ?? 50, 1000);
  const offset = f.offset ?? 0;
  const order = sql.unsafe(ORDER[f.sort ?? "score"]);

  // ONE scan for every aggregate. The first cut ran 16 sequential queries (total,
  // universe, 6 facets, 7 recency counts) at ~1s each — 15.8s for a page view.
  // A MATERIALIZED CTE scans the filtered set once; the facet GROUP BYs and the
  // recency FILTER counts then run over that result in memory. Two queries total:
  // this one, and the page of rows below.
  const facetSub = (expr: string) =>
    `(SELECT COALESCE(jsonb_agg(jsonb_build_array(v, n) ORDER BY n DESC), '[]'::jsonb)
        FROM (SELECT ${expr} AS v, count(*)::int n FROM f
              WHERE ${expr} IS NOT NULL AND btrim(${expr}::text) <> ''
              GROUP BY 1 ORDER BY n DESC LIMIT 40) t)`;

  const [agg] = await sql<Record<string, unknown>[]>`
    WITH f AS MATERIALIZED (
      SELECT country, platform, city, category, btrim(theme) AS theme,
             ${band} AS band,
             COALESCE((CASE WHEN first_product_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN left(first_product_at,10)::date END), launched_at) AS launched_on,
             discovered_at
      FROM imported_stores WHERE ${where}
    )
    SELECT (SELECT count(*)::int FROM f) AS total,
           ${sql.unsafe(facetSub("country"))}  AS f_country,
           ${sql.unsafe(facetSub("platform"))} AS f_platform,
           ${sql.unsafe(facetSub("band"))}     AS f_band,
           ${sql.unsafe(facetSub("category"))} AS f_category,
           ${sql.unsafe(facetSub("city"))}     AS f_city,
           ${sql.unsafe(facetSub("theme"))}    AS f_theme,
           (SELECT jsonb_build_object(
              '7',   count(*) FILTER (WHERE launched_on >= CURRENT_DATE - 7),
              '30',  count(*) FILTER (WHERE launched_on >= CURRENT_DATE - 30),
              '90',  count(*) FILTER (WHERE launched_on >= CURRENT_DATE - 90),
              '365', count(*) FILTER (WHERE launched_on >= CURRENT_DATE - 365)) FROM f) AS r_launched,
           (SELECT jsonb_build_object(
              '7',   count(*) FILTER (WHERE discovered_at >= CURRENT_DATE - 7),
              '30',  count(*) FILTER (WHERE discovered_at >= CURRENT_DATE - 30),
              '365', count(*) FILTER (WHERE discovered_at >= CURRENT_DATE - 365)) FROM f) AS r_discovered`;

  const total = Number(agg.total);
  const toFacet = (v: unknown): Facet =>
    ((v ?? []) as [string, number][]).map(([value, count]) => ({ value: String(value), count: Number(count) }));
  const toRec = (v: unknown): Record<number, number> =>
    Object.fromEntries(Object.entries((v ?? {}) as Record<string, number>).map(([k, n]) => [Number(k), Number(n)]));

  const rows = await sql<Record<string, unknown>[]>`
    SELECT domain, name, category, country, city, platform, btrim(theme) AS theme, plus,
           (email IS NOT NULL AND email <> '') AS has_email,
           ${usd}::int AS usd, ${band} AS band, discovered_at, ${launchSel},
           (domain IN (SELECT domain FROM store_tags WHERE tag='top-100')) AS top100,
           (domain IN (SELECT domain FROM store_tags WHERE tag='top-500')) AS top500
    FROM imported_stores WHERE ${where}
    ORDER BY ${order}, domain ASC
    LIMIT ${limit} OFFSET ${offset}`;

  return {
    total,
    universe: await universeCount(),
    rows: rows.map((r) => ({
      domain: r.domain as string, name: (r.name as string) ?? null, category: (r.category as string) ?? null,
      country: (r.country as string) ?? null, city: (r.city as string) ?? null,
      platform: (r.platform as string) ?? null, theme: (r.theme as string) ?? null,
      plus: !!r.plus, hasEmail: !!r.has_email,
      estMonthlySales: r.usd == null ? null : Number(r.usd),
      band: revenueBand(r.usd == null ? null : Number(r.usd)),
      launchedAt: d(r.launched_on ? String(r.launched_on) : null),
      discoveredAt: d(r.discovered_at ? String(r.discovered_at) : null),
      top100: !!r.top100, top500: !!r.top500,
      score: 0,
    })),
    facets: {
      country: toFacet(agg.f_country), platform: toFacet(agg.f_platform),
      band: toFacet(agg.f_band), category: toFacet(agg.f_category),
      city: toFacet(agg.f_city), theme: toFacet(agg.f_theme),
    },
    recency: { launched: toRec(agg.r_launched), discovered: toRec(agg.r_discovered) },
  };
}
