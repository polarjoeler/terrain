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
import { usdSqlExpr, bandSqlExpr, revenueBand, toUsd, type RevenueBand } from "./fx.ts";
import { scoreLead } from "./leads-explore.ts";
import { db as sharedDb } from "./db";

// Shared pool (see lib/db.ts). This module previously created its own pool WITHOUT prepare:false —
// a latent bug on the Supabase transaction pooler (which rejects prepared statements). The shared
// pool sets prepare:false, so moving to it fixes that as well as the cold-start/connection cost.
function db() {
  return sharedDb();
}

const VISIBLE_MARKETS = ["ZA", "KE", "NG"] as const;
const HIDDEN_PLATFORMS = ["wix", "adobe_commerce", "magento"];

export type SortKey = "score" | "sales" | "name" | "launched" | "discovered";

export type BrowseFilters = {
  q?: string;
  country?: string[]; platform?: string[]; category?: string[];
  band?: string[]; theme?: string[]; city?: string[];
  payment?: string[]; shipping?: string[]; app?: string[];
  activity?: string[]; hosting?: string[];
  plus?: boolean; hasEmail?: boolean; noPayment?: boolean;
  tier?: "top100" | "top500";
  launchedDays?: number;      // launched within N days
  discoveredDays?: number;    // we first tracked it within N days
  sort?: SortKey;
  limit?: number; offset?: number;
};

/** One table row. Only the fields the leads table actually renders — apps, hosting,
 *  plugins, platform_version, product titles, full socials etc. still load from the
 *  drawer on click. The payload win is PAGINATION (50 rows, not ~13k), so these rows
 *  carry what the table shows rather than being stripped bare. */
export type BrowseRow = {
  domain: string; name: string | null; category: string | null;
  country: string | null; city: string | null;
  platform: string | null; theme: string | null;
  plus: boolean; activityTier: string | null;
  estMonthlySales: number | null; band: RevenueBand;
  productCount: number | null; aovUsd: number | null;
  email: string | null; instagram: string | null; facebook: string | null; tiktok: string | null;
  launchedAt: string | null; discoveredAt: string | null;
  top100: boolean; top500: boolean;
  score: number;
};

export type Facet = { value: string; count: number }[];

export type BrowseResult = {
  rows: BrowseRow[];
  total: number;              // true count for the current filters
  universe: number;           // true count with no filters at all
  // Live-stat tiles — true over the whole filtered set, not just the page.
  stats: { plus: number; email: number };
  facets: {
    country: Facet; platform: Facet; band: Facet;
    category: Facet; city: Facet; theme: Facet;
    activity: Facet; hosting: Facet;
    payment: Facet; shipping: Facet; apps: Facet;   // multi-token (a store has several)
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
  if (f.app?.length) conds.push(sql`apps ILIKE ANY(${f.app.map((a) => `%${a}%`)})`);
  if (f.activity?.length) conds.push(sql`activity_tier = ANY(${f.activity})`);
  if (f.hosting?.length) conds.push(sql`hosting_provider = ANY(${f.hosting})`);
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

// The counts + facets are the slow half: they aggregate the whole filtered universe (a 3–10s scan on
// this instance under fleet load), whereas the row page is a ~450ms indexed LIMIT. But they depend
// only on the FILTER — not on paging or sort — and don't change second-to-second. So cache the parsed
// aggregate per filter: "Load more", a re-sort, and repeat visits then pay only the rows query, and a
// burst of identical requests collapses onto one scan. Process-local + short TTL (serve-stale is fine
// for facet counts); the universe count has its own cache above.
type AggParsed = {
  total: number;
  stats: { plus: number; email: number };
  facets: BrowseResult["facets"];
  recency: BrowseResult["recency"];
};
const AGG_TTL_MS = 5 * 60_000;
const _aggCache = new Map<string, { at: number; v: AggParsed }>();
/** Cache key: every filter EXCEPT paging + sort, which don't affect counts or facets. */
function aggKey(f: BrowseFilters): string {
  const { limit: _l, offset: _o, sort: _s, ...rest } = f;
  return JSON.stringify(rest);
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
  // Single-column facet (country/platform/band/…): group the materialized set.
  const facetSub = (expr: string) =>
    `(SELECT COALESCE(jsonb_agg(jsonb_build_array(v, n) ORDER BY n DESC), '[]'::jsonb)
        FROM (SELECT ${expr} AS v, count(*)::int n FROM f
              WHERE ${expr} IS NOT NULL AND btrim(${expr}::text) <> ''
              GROUP BY 1 ORDER BY n DESC LIMIT 40) t)`;
  // Multi-token facet (payments/shipping): a store has several, so split on ';' and count each.
  const multiFacet = (col: string) =>
    `(SELECT COALESCE(jsonb_agg(jsonb_build_array(v, n) ORDER BY n DESC), '[]'::jsonb)
        FROM (SELECT btrim(tok) AS v, count(*)::int n
              FROM f, unnest(string_to_array(COALESCE(f.${col}, ''), ';')) AS tok
              WHERE btrim(tok) <> '' GROUP BY 1 ORDER BY n DESC LIMIT 40) t)`;
  // Apps are concatenated Shopify app-store URLs — pull every slug and count it. The facet VALUE is
  // the slug (so the `apps ILIKE %slug%` filter matches the stored URL); the UI title-cases it.
  const appsFacet =
    `(SELECT COALESCE(jsonb_agg(jsonb_build_array(v, n) ORDER BY n DESC), '[]'::jsonb)
        FROM (SELECT lower(m[1]) AS v, count(*)::int n
              FROM f, regexp_matches(COALESCE(f.apps, ''), 'apps\\.shopify\\.com/([a-z0-9][a-z0-9-]*)', 'g') AS m
              WHERE m[1] NOT IN ('partners','collections','browse','categories','stores')
              GROUP BY 1 ORDER BY n DESC LIMIT 40) t)`;

  const toFacet = (v: unknown): Facet =>
    ((v ?? []) as [string, number][]).map(([value, count]) => ({ value: String(value), count: Number(count) }));
  const toRec = (v: unknown): Record<number, number> =>
    Object.fromEntries(Object.entries((v ?? {}) as Record<string, number>).map(([k, n]) => [Number(k), Number(n)]));

  const key = aggKey(f);
  const hit = _aggCache.get(key);
  let A: AggParsed;
  if (hit && Date.now() - hit.at < AGG_TTL_MS) {
    A = hit.v;
  } else {
    const [agg] = await sql<Record<string, unknown>[]>`
    WITH f AS MATERIALIZED (
      SELECT country, platform, city, category, btrim(theme) AS theme,
             ${band} AS band, activity_tier, hosting_provider,
             payments, shipping_providers, apps, plus,
             (email IS NOT NULL AND email <> '') AS has_email,
             COALESCE((CASE WHEN first_product_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN left(first_product_at,10)::date END), launched_at) AS launched_on,
             discovered_at
      FROM imported_stores WHERE ${where}
    )
    SELECT (SELECT count(*)::int FROM f) AS total,
           (SELECT (count(*) FILTER (WHERE plus))::int FROM f)       AS c_plus,
           (SELECT (count(*) FILTER (WHERE has_email))::int FROM f)  AS c_email,
           ${sql.unsafe(facetSub("country"))}       AS f_country,
           ${sql.unsafe(facetSub("platform"))}      AS f_platform,
           ${sql.unsafe(facetSub("band"))}          AS f_band,
           ${sql.unsafe(facetSub("category"))}      AS f_category,
           ${sql.unsafe(facetSub("city"))}          AS f_city,
           ${sql.unsafe(facetSub("theme"))}         AS f_theme,
           ${sql.unsafe(facetSub("activity_tier"))} AS f_activity,
           ${sql.unsafe(facetSub("hosting_provider"))} AS f_hosting,
           ${sql.unsafe(multiFacet("payments"))}         AS f_payment,
           ${sql.unsafe(multiFacet("shipping_providers"))} AS f_shipping,
           ${sql.unsafe(appsFacet)}                   AS f_apps,
           (SELECT jsonb_build_object(
              '7',   count(*) FILTER (WHERE launched_on >= CURRENT_DATE - 7),
              '30',  count(*) FILTER (WHERE launched_on >= CURRENT_DATE - 30),
              '90',  count(*) FILTER (WHERE launched_on >= CURRENT_DATE - 90),
              '365', count(*) FILTER (WHERE launched_on >= CURRENT_DATE - 365)) FROM f) AS r_launched,
           (SELECT jsonb_build_object(
              '7',   count(*) FILTER (WHERE discovered_at >= CURRENT_DATE - 7),
              '30',  count(*) FILTER (WHERE discovered_at >= CURRENT_DATE - 30),
              '365', count(*) FILTER (WHERE discovered_at >= CURRENT_DATE - 365)) FROM f) AS r_discovered`;
    A = {
      total: Number(agg.total),
      stats: { plus: Number(agg.c_plus ?? 0), email: Number(agg.c_email ?? 0) },
      facets: {
        country: toFacet(agg.f_country), platform: toFacet(agg.f_platform),
        band: toFacet(agg.f_band), category: toFacet(agg.f_category),
        city: toFacet(agg.f_city), theme: toFacet(agg.f_theme),
        activity: toFacet(agg.f_activity), hosting: toFacet(agg.f_hosting),
        payment: toFacet(agg.f_payment), shipping: toFacet(agg.f_shipping), apps: toFacet(agg.f_apps),
      },
      recency: { launched: toRec(agg.r_launched), discovered: toRec(agg.r_discovered) },
    };
    _aggCache.set(key, { at: Date.now(), v: A });
  }

  const rows = await sql<Record<string, unknown>[]>`
    SELECT domain, name, category, country, city, platform, btrim(theme) AS theme, plus,
           activity_tier, email, instagram, facebook, tiktok,
           instagram_followers, facebook_followers, product_count, avg_product_price, currency,
           ${usd}::int AS usd, discovered_at, ${launchSel},
           (domain IN (SELECT domain FROM store_tags WHERE tag='top-100')) AS top100,
           (domain IN (SELECT domain FROM store_tags WHERE tag='top-500')) AS top500
    FROM imported_stores WHERE ${where}
    ORDER BY ${order}, domain ASC
    LIMIT ${limit} OFFSET ${offset}`;

  return {
    total: A.total,
    universe: await universeCount(),
    stats: A.stats,
    rows: rows.map((r) => {
      const sales = r.usd == null ? null : Number(r.usd);
      const aov = toUsd(r.avg_product_price != null ? Number(r.avg_product_price) : null, (r.currency as string) ?? null, (r.country as string) ?? null);
      const social = (Number(r.instagram_followers) || 0) + (Number(r.facebook_followers) || 0);
      const email = (r.email as string) || null;
      const catalog = Number(r.product_count) || 0;
      return {
        domain: r.domain as string, name: (r.name as string) ?? null, category: (r.category as string) ?? null,
        country: (r.country as string) ?? null, city: (r.city as string) ?? null,
        platform: (r.platform as string) ?? null, theme: (r.theme as string) ?? null,
        plus: !!r.plus, activityTier: (r.activity_tier as string) ?? null,
        estMonthlySales: sales, band: revenueBand(sales),
        productCount: r.product_count == null ? null : Number(r.product_count), aovUsd: aov,
        email, instagram: (r.instagram as string) ?? null, facebook: (r.facebook as string) ?? null, tiktok: (r.tiktok as string) ?? null,
        launchedAt: d(r.launched_on ? String(r.launched_on) : null),
        discoveredAt: d(r.discovered_at ? String(r.discovered_at) : null),
        top100: !!r.top100, top500: !!r.top500,
        score: scoreLead(sales ?? 0, !!email, !!r.plus, social, r.discovered_at ? new Date(r.discovered_at as string) : null, catalog, aov ?? 0),
      };
    }),
    facets: A.facets,
    recency: A.recency,
  };
}

/** CSV of the FULL filtered set (every matching row, full field set) — the Explorer's "Export → CSV".
 *  This replaced a client-side export that only ever wrote the rows the browser had loaded; the lean
 *  paginated rows no longer carry the full field set, so the export re-queries it here. Capped so a
 *  pathological filter can't stream the whole table; ordered by revenue like the old export. */
const EXPORT_CAP = 50_000;
export async function browseExportCsv(f: BrowseFilters = {}): Promise<string> {
  const sql = db();
  const where = buildWhere(f);
  const usd = sql.unsafe(usdSqlExpr());
  const band = sql.unsafe(bandSqlExpr());
  const out = await sql<Record<string, unknown>[]>`
    SELECT domain, name, category, country, city, platform, activity_tier, activity_score,
           hosting_provider, platform_version, btrim(theme) AS theme, product_count, avg_product_price,
           currency, ${usd}::int AS usd, ${band} AS band, plus, email, payments, shipping_providers,
           apps, instagram, facebook, tiktok
    FROM imported_stores WHERE ${where}
    ORDER BY estimated_monthly_sales DESC NULLS LAST, domain ASC
    LIMIT ${EXPORT_CAP}`;
  const head = ["domain", "name", "category", "country", "city", "platform", "activity_tier", "activity_score", "hosting", "platform_version", "theme", "product_count", "aov_usd", "est_monthly_sales_usd", "revenue_band", "plus", "email", "payments", "shipping", "apps", "instagram", "facebook", "tiktok"];
  const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = out.map((r) => {
    const sales = r.usd == null ? null : Number(r.usd);
    const aov = toUsd(r.avg_product_price != null ? Number(r.avg_product_price) : null, (r.currency as string) ?? null, (r.country as string) ?? null);
    return [r.domain, r.name, r.category, r.country, r.city, r.platform, r.activity_tier, r.activity_score,
      r.hosting_provider, r.platform_version, r.theme, r.product_count, aov == null ? null : Math.round(aov),
      sales, revenueBand(sales), r.plus, r.email, r.payments, r.shipping_providers, r.apps,
      r.instagram, r.facebook, r.tiktok].map(esc).join(",");
  });
  return [head.join(","), ...lines].join("\n");
}
