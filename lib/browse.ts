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
import { scoreExpr } from "./score.ts";
import { db as sharedDb } from "./db";

// Shared pool (see lib/db.ts). This module previously created its own pool WITHOUT prepare:false —
// a latent bug on the Supabase transaction pooler (which rejects prepared statements). The shared
// pool sets prepare:false, so moving to it fixes that as well as the cold-start/connection cost.
function db() {
  return sharedDb();
}

const VISIBLE_MARKETS = ["ZA", "KE", "NG"] as const;

/** The address we would actually send to. Once contact-enrich has visited a store (stamping
 *  contact_checked_at), contact_email is the best of every address found across its contact
 *  surface — the imported `email` among them — so it wins. Before that pass reaches a store the
 *  imported address is all we can trust. Mirrors bestEmail() in the lead drawer; keep them in step. */
const bestEmailSql = "CASE WHEN contact_checked_at IS NOT NULL THEN COALESCE(contact_email, email) ELSE email END";
/** Contact types that reach a human rather than a queue — what "has a named contact" means. */
const REACHABLE_TYPES = ["named", "role_targeted"] as const;
/** ...and it has to be able to receive mail. contact_mx_ok is FALSE only when the address's domain
 *  publishes no MX record at all — a guaranteed bounce however good the local-part looks. NULL
 *  means not yet checked or DNS wouldn't answer, which must not be treated as undeliverable, hence
 *  IS NOT FALSE rather than = true. (scripts/contact-mx.mjs) */
const DELIVERABLE = "contact_mx_ok IS NOT FALSE";

export type SortKey = "new" | "score" | "sales" | "name" | "launched" | "discovered";

export type BrowseFilters = {
  q?: string;
  country?: string[]; platform?: string[]; category?: string[];
  band?: string[]; theme?: string[]; city?: string[];
  payment?: string[]; shipping?: string[]; app?: string[]; plugin?: string[];
  activity?: string[]; hosting?: string[];
  plus?: boolean; hasEmail?: boolean; noPayment?: boolean;
  /** Contact-quality facet: 'named' | 'role_targeted' | 'role_generic' | 'form_only' | 'none'. */
  contactType?: string[];
  /** Shorthand for the filter customers actually want: an address that reaches a person
   *  AND can actually receive mail. */
  reachableContact?: boolean;
  /** Drop addresses whose domain publishes no MX — the bounce list. */
  deliverable?: boolean;
  tier?: "top100" | "top500";
  domains?: string[];         // explicit selection (export the ticked rows), overrides the broad filter
  launchedDays?: number;      // launched within N days
  discoveredDays?: number;    // we first tracked it within N days
  status?: "migrated" | "dead"; // show stores in this terminal state (overrides the default live-only filter)
  checkedDays?: number;       // ...whose status was confirmed within N days (pairs with `status`)
  sort?: SortKey;
  limit?: number; offset?: number;
  refresh?: boolean;          // internal: force a fresh aggregate (bypass caches) — used by refresh-browse
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
  /** `email` is the best address we hold (see bestEmailSql) — not the raw imported column. */
  email: string | null; instagram: string | null; facebook: string | null; tiktok: string | null;
  /** Contact quality, so the table can say WHAT the address is instead of just showing it. */
  contactType: string | null; contactName: string | null; whatsapp: string | null;
  /** false = the address's domain has no MX and will bounce; null = not checked yet.
   *  sharedCount > 1 = another tracked store uses this same address (agency / head office). */
  contactMxOk: boolean | null; contactSharedCount: number | null;
  launchedAt: string | null; discoveredAt: string | null;
  top100: boolean; top500: boolean;
  /** CrUX traffic-rank bucket (1000 = top 1k, lower is bigger) and the CrUX month it came from,
   *  so the table can show both the ranking and how fresh it is. `cruxTrend` is the move since
   *  the previous month we hold: up | down | flat | new. */
  cruxRank: number | null; cruxRankMonth: string | null; cruxTrend: string | null;
  score: number;
};

export type Facet = { value: string; count: number }[];

export type BrowseResult = {
  rows: BrowseRow[];
  total: number;              // true count for the current filters
  universe: number;           // true count with no filters at all
  // Live-stat tiles — true over the whole filtered set, not just the page.
  stats: { plus: number; email: number; reachable: number; willBounce: number };
  facets: {
    country: Facet; platform: Facet; band: Facet; contactType: Facet;
    category: Facet; city: Facet; theme: Facet;
    activity: Facet; hosting: Facet;
    payment: Facet; shipping: Facet; apps: Facet; plugins: Facet;   // multi-token (a store has several)
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
    sql`country = ANY(${[...VISIBLE_MARKETS]})`,
  ];
  if (f.status === "migrated" || f.status === "dead") {
    // Terminal-state view (from the Overview "Migrations" / "Went dark" chips) — show exactly those.
    conds.push(sql`live_status = ${f.status}`);
    if (f.checkedDays) conds.push(sql`live_checked_at >= CURRENT_DATE - ${f.checkedDays}::int`);
  } else {
    conds.push(sql`(live_status IS NULL OR live_status NOT IN ('dead','migrated'))`);
    // Brochure/parked installs (any CMS) stay in the DB, tagged, and are browsable via the
    // "not_a_store" activity facet — but hidden from the default lead list (they aren't leads)
    // and never counted in Insights as live stores. Ticking the facet surfaces them.
    if (!f.activity?.includes("not_a_store")) {
      conds.push(sql`activity_tier IS DISTINCT FROM 'not_a_store'`);
    }
  }
  if (f.domains?.length) conds.push(sql`domain = ANY(${f.domains})`);
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
  if (f.plugin?.length) conds.push(sql`plugins ILIKE ANY(${f.plugin.map((a) => `%${a}%`)})`);
  if (f.activity?.length) conds.push(sql`activity_tier = ANY(${f.activity})`);
  if (f.hosting?.length) conds.push(sql`hosting_provider = ANY(${f.hosting})`);
  if (f.plus) conds.push(sql`plus`);
  if (f.hasEmail) conds.push(sql`${sql.unsafe(bestEmailSql)} IS NOT NULL AND ${sql.unsafe(bestEmailSql)} <> ''`);
  if (f.contactType?.length) conds.push(sql`contact_type = ANY(${f.contactType})`);
  if (f.reachableContact) conds.push(sql`contact_type = ANY(${[...REACHABLE_TYPES]}) AND ${sql.unsafe(DELIVERABLE)}`);
  if (f.deliverable) conds.push(sql.unsafe(DELIVERABLE));
  if (f.noPayment) conds.push(sql`payments_checked_at IS NOT NULL AND (payments IS NULL OR payments = '')`);
  if (f.tier) conds.push(sql`domain IN (SELECT domain FROM store_tags WHERE tag = ${f.tier === "top100" ? "top-100" : "top-500"})`);
  if (f.launchedDays) conds.push(sql`${launchExpr} >= CURRENT_DATE - ${f.launchedDays}::int`);
  if (f.discoveredDays) conds.push(sql`discovered_at >= CURRENT_DATE - ${f.discoveredDays}::int`);
  return conds.reduce((a, c) => sql`${a} AND ${c}`);
}

const ORDER: Record<SortKey, string> = {
  // Default view: most-recently-discovered first (the primary driver). Pure discovered_at DESC, so
  // today's live CT finds lead page 1; revenue breaks ties within a day's batch. A blended "new in
  // last N days then by revenue" was useless here — ~84% of rows were stamped this month by bulk
  // imports, so the window didn't discriminate and it collapsed back to a revenue sort.
  new: "discovered_at DESC NULLS LAST, estimated_monthly_sales DESC NULLS LAST",
  sales: "estimated_monthly_sales DESC NULLS LAST",
  name: "COALESCE(name, domain) ASC",
  launched: "launched_on DESC NULLS LAST",
  discovered: "discovered_at DESC NULLS LAST",
  score: `(${scoreExpr()}) DESC`, // the real lead-fit score (SQL), so non-Shopify ranks on merit not just revenue
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
  stats: { plus: number; email: number; reachable: number; willBounce: number };
  facets: BrowseResult["facets"];
  recency: BrowseResult["recency"];
};
const AGG_TTL_MS = 5 * 60_000;
const _aggCache = new Map<string, { at: number; v: AggParsed }>();
/** Cache key: every filter EXCEPT paging + sort, which don't affect counts or facets. */
function aggKey(f: BrowseFilters): string {
  const { limit: _l, offset: _o, sort: _s, refresh: _r, ...rest } = f;
  return JSON.stringify(rest);
}

// L2: a durable, cross-instance aggregate cache in Postgres. The in-process Map above only warms a
// single serverless instance for 5 min; a cold instance (or one past the TTL) otherwise re-runs the
// 3–30s scan — the exact cold-load pain. browse_cache persists each computed aggregate so ANY cold
// instance reads it back in one indexed lookup (~a round-trip) instead of re-aggregating, and
// refresh-browse keeps the hot keys (unfiltered + per-country) fresh ahead of traffic. Reads/writes
// are best-effort: if the table is missing or the DB is busy, we silently fall back to a live scan.
const BROWSE_CACHE_TTL = "90 minutes";     // serve-stale window; refresh-browse rewrites hot keys well inside it
async function dbAggGet(sql: ReturnType<typeof db>, key: string): Promise<AggParsed | null> {
  try {
    const [row] = await sql<{ data: AggParsed }[]>`
      SELECT data FROM browse_cache
      WHERE key = ${key} AND updated_at > now() - ${BROWSE_CACHE_TTL}::interval`;
    return row?.data ?? null;
  } catch { return null; }
}
async function dbAggSet(sql: ReturnType<typeof db>, key: string, v: AggParsed): Promise<void> {
  try {
    await sql`INSERT INTO browse_cache (key, data, updated_at) VALUES (${key}, ${sql.json(v as never)}, now())
      ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`;
  } catch { /* table missing or DB busy — caching is best-effort */ }
}

export async function browseQuery(f: BrowseFilters = {}): Promise<BrowseResult> {
  const sql = db();
  const where = buildWhere(f);
  const usd = sql.unsafe(usdSqlExpr());
  const band = sql.unsafe(bandSqlExpr());
  // The Apps facet is a regex over every row's app-store URLs — the single most expensive sub-query.
  // Apps exist only on Shopify stores and the UI only shows the Apps facet when Shopify is selected,
  // so compute it ONLY then; otherwise return an empty facet and skip the scan.
  const wantApps = f.platform?.some((p) => p.toLowerCase() === "shopify") ?? false;
  const launchSel = sql.unsafe(
    `COALESCE((CASE WHEN first_product_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN left(first_product_at,10)::date END), launched_at) AS launched_on`,
  );
  const limit = Math.min(f.limit ?? 50, 1000);
  const offset = f.offset ?? 0;
  const order = sql.unsafe(ORDER[f.sort ?? "new"]);

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
  const memHit = f.refresh ? undefined : _aggCache.get(key);
  let A: AggParsed | null = memHit && Date.now() - memHit.at < AGG_TTL_MS ? memHit.v : null;
  if (!A && !f.refresh) A = await dbAggGet(sql, key);   // L2: durable cross-instance cache, read before the heavy scan
  if (A) {
    _aggCache.set(key, { at: Date.now(), v: A });
  } else {
    const [agg] = await sql<Record<string, unknown>[]>`
    WITH f AS MATERIALIZED (
      SELECT country, platform, city, category, btrim(theme) AS theme,
             ${band} AS band, activity_tier, hosting_provider,
             payments, shipping_providers, apps, plugins, plus, contact_type,
             (${sql.unsafe(bestEmailSql)} IS NOT NULL AND ${sql.unsafe(bestEmailSql)} <> '') AS has_email,
             (contact_type = ANY(${[...REACHABLE_TYPES]}) AND ${sql.unsafe(DELIVERABLE)}) AS reachable,
             (contact_mx_ok IS FALSE) AS will_bounce,
             COALESCE((CASE WHEN first_product_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN left(first_product_at,10)::date END), launched_at) AS launched_on,
             discovered_at
      FROM imported_stores WHERE ${where}
    )
    SELECT (SELECT count(*)::int FROM f) AS total,
           (SELECT (count(*) FILTER (WHERE plus))::int FROM f)       AS c_plus,
           (SELECT (count(*) FILTER (WHERE has_email))::int FROM f)  AS c_email,
           (SELECT (count(*) FILTER (WHERE reachable))::int FROM f)   AS c_reachable,
           (SELECT (count(*) FILTER (WHERE will_bounce))::int FROM f) AS c_bounce,
           ${sql.unsafe(facetSub("contact_type"))}  AS f_contact,
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
           ${sql.unsafe(wantApps ? appsFacet : "'[]'::jsonb")}                   AS f_apps,
           ${sql.unsafe(multiFacet("plugins"))} AS f_plugins,
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
      stats: { plus: Number(agg.c_plus ?? 0), email: Number(agg.c_email ?? 0), reachable: Number(agg.c_reachable ?? 0), willBounce: Number(agg.c_bounce ?? 0) },
      facets: {
        country: toFacet(agg.f_country), platform: toFacet(agg.f_platform),
        band: toFacet(agg.f_band), category: toFacet(agg.f_category), contactType: toFacet(agg.f_contact),
        city: toFacet(agg.f_city), theme: toFacet(agg.f_theme),
        activity: toFacet(agg.f_activity), hosting: toFacet(agg.f_hosting),
        payment: toFacet(agg.f_payment), shipping: toFacet(agg.f_shipping), apps: toFacet(agg.f_apps), plugins: toFacet(agg.f_plugins),
      },
      recency: { launched: toRec(agg.r_launched), discovered: toRec(agg.r_discovered) },
    };
    _aggCache.set(key, { at: Date.now(), v: A });
    void dbAggSet(sql, key, A);   // write-through so the next cold instance reads it back instead of re-scanning
  }

  const rows = await sql<Record<string, unknown>[]>`
    SELECT domain, name, category, country, city, platform, btrim(theme) AS theme, plus,
           activity_tier, ${sql.unsafe(bestEmailSql)} AS email,
           contact_type, contact_name, whatsapp, contact_mx_ok, contact_shared_count,
           instagram, facebook, tiktok,
           instagram_followers, facebook_followers, product_count, avg_product_price, currency,
           ${usd}::int AS usd, ${sql.unsafe(scoreExpr())} AS fit_score, discovered_at, ${launchSel},
           crux_rank, crux_rank_month, crux_trend,
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
      const email = (r.email as string) || null;
      return {
        domain: r.domain as string, name: (r.name as string) ?? null, category: (r.category as string) ?? null,
        country: (r.country as string) ?? null, city: (r.city as string) ?? null,
        platform: (r.platform as string) ?? null, theme: (r.theme as string) ?? null,
        plus: !!r.plus, activityTier: (r.activity_tier as string) ?? null,
        estMonthlySales: sales, band: revenueBand(sales),
        productCount: r.product_count == null ? null : Number(r.product_count), aovUsd: aov,
        email, instagram: (r.instagram as string) ?? null, facebook: (r.facebook as string) ?? null, tiktok: (r.tiktok as string) ?? null,
        contactType: (r.contact_type as string) ?? null, contactName: (r.contact_name as string) ?? null,
        whatsapp: (r.whatsapp as string) ?? null,
        contactMxOk: r.contact_mx_ok == null ? null : Boolean(r.contact_mx_ok),
        contactSharedCount: r.contact_shared_count == null ? null : Number(r.contact_shared_count),
        launchedAt: d(r.launched_on ? String(r.launched_on) : null),
        discoveredAt: d(r.discovered_at ? String(r.discovered_at) : null),
        top100: !!r.top100, top500: !!r.top500,
        cruxRank: r.crux_rank == null ? null : Number(r.crux_rank),
        cruxRankMonth: (r.crux_rank_month as string) ?? null,
        cruxTrend: (r.crux_trend as string) ?? null,
        score: Number(r.fit_score) || 0,
      };
    }),
    facets: A.facets,
    recency: A.recency,
  };
}

/** Recompute the hot-filter aggregates and write them to browse_cache, so cold page loads (default
 *  view AND the common filter drill-downs) read a precomputed result instead of running the 3–30s
 *  scan on the busy pooler. Called on a schedule by /api/cron/refresh-browse. refresh:true forces a
 *  fresh scan so it rewrites rather than re-reading its own cache. Returns how many keys were warmed.
 *
 *  Which combos: the unfiltered default, each market, each top CMS, the main market × each top CMS,
 *  and the "no payment gateway yet" prospect list (per market). The country/CMS VALUES are read from
 *  the live facets — they're mixed-case in the data ("Shopify", "wix") and must match what the UI
 *  sends on a click, so we derive them rather than hardcode. Every other combination still
 *  write-throughs on its first live computation. */
export async function refreshBrowseCache(): Promise<number> {
  const sql = db();
  // One-time table create (idempotent); this runs on a schedule, not per request, so the brief lock is fine.
  await sql`CREATE TABLE IF NOT EXISTS browse_cache (key TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`.catch(() => {});

  // The unfiltered aggregate both warms the default view AND gives us the real facet VALUES to warm
  // per-dimension (exact, mixed-case). If even this can't run, bail — the DB is too busy to warm.
  let base: BrowseResult;
  try { base = await browseQuery({ refresh: true, limit: 1 }); } catch { return 0; }
  let warmed = 1;

  const countries = base.facets.country.slice(0, 3).map((f) => f.value);       // ZA, KE, NG
  const platforms = base.facets.platform.slice(0, 3).map((f) => f.value);      // top 3 CMSs
  const main = countries[0];                                                   // primary market (ZA)
  const combos: BrowseFilters[] = [
    ...countries.map((c) => ({ country: [c] })),
    ...platforms.map((p) => ({ platform: [p] })),
    ...(main ? platforms.map((p) => ({ country: [main], platform: [p] })) : []),
    { noPayment: true },
    ...countries.map((c) => ({ country: [c], noPayment: true })),
  ];
  for (const f of combos) {
    try { await browseQuery({ ...f, refresh: true, limit: 1 }); warmed++; } catch { /* skip a failed key */ }
  }
  return warmed;
}

/** CSV of the FULL filtered set (every matching row, full field set) — the Explorer's "Export → CSV".
 *  This replaced a client-side export that only ever wrote the rows the browser had loaded; the lean
 *  paginated rows no longer carry the full field set, so the export re-queries it here. Capped so a
 *  pathological filter can't stream the whole table; ordered by revenue like the old export. */
const EXPORT_CAP = 50_000;
export type ExportCell = string | number | boolean | null;
/** The full filtered export as a header + structured rows — shared by the CSV download and the Google
 *  Sheets export (which needs real cells, not an escaped CSV string). */
export async function browseExportRows(f: BrowseFilters = {}): Promise<{ header: string[]; rows: ExportCell[][] }> {
  const sql = db();
  const where = buildWhere(f);
  const usd = sql.unsafe(usdSqlExpr());
  const band = sql.unsafe(bandSqlExpr());
  const out = await sql<Record<string, unknown>[]>`
    SELECT domain, name, category, country, city, platform, activity_tier, activity_score,
           hosting_provider, platform_version, btrim(theme) AS theme, product_count, avg_product_price,
           currency, ${usd}::int AS usd, ${band} AS band, plus,
           ${sql.unsafe(bestEmailSql)} AS email, contact_type, contact_name, contact_role,
           whatsapp, contact_phone, contact_form_url, contact_mx_ok, contact_mx_provider,
           contact_shared_count, contact_email_guess, contact_guess_status, payments, shipping_providers,
           logistics_apps, apps, plugins, technologies, instagram, facebook, tiktok, linkedin
    FROM imported_stores WHERE ${where}
    ORDER BY estimated_monthly_sales DESC NULLS LAST, domain ASC
    LIMIT ${EXPORT_CAP}`;
  // Shopify add-ons live in `apps` (apps.shopify.com slugs); every other CMS exposes them as `plugins`
  // (wp-content/plugins, /modules/…) + cross-platform third-party `technologies` (Klaviyo, Gorgias, …).
  // Normalise `apps` to bare slugs so the column reads the same across platforms.
  const appSlugs = (s: unknown) => String(s ?? "").match(/apps\.shopify\.com\/([a-z0-9][a-z0-9-]*)/gi)?.map((u) => u.split("/").pop()).join("; ") || null;
  // `shipping_providers` is the Shopify checkout read; `logistics_apps` is the cross-platform homepage
  // carrier fingerprint (Bob Go, Pargo, TUNL…). Merge them so non-Shopify stores show shipping too.
  const shipMerged = (a: unknown, b: unknown) => [...new Set(`${a ?? ""};${b ?? ""}`.split(";").map((x) => x.trim()).filter(Boolean))].join("; ") || null;
  // contact_type is exported next to the address on purpose: a CSV of bare emails is exactly the
  // artefact customers complain about, because nothing in it says which rows are worth a send.
  const header = ["domain", "name", "category", "country", "city", "platform", "activity_tier", "activity_score", "hosting", "platform_version", "theme", "product_count", "aov_usd", "est_monthly_sales_usd", "revenue_band", "plus", "email", "contact_type", "contact_name", "contact_role", "whatsapp", "phone", "contact_form", "deliverable", "mail_provider", "shared_with_n_stores", "likely_personal_email_INFERRED", "inferred_status", "payments", "shipping", "apps", "plugins", "technologies", "instagram", "facebook", "tiktok", "linkedin"];
  const rows: ExportCell[][] = out.map((r) => {
    const sales = r.usd == null ? null : Number(r.usd);
    const aov = toUsd(r.avg_product_price != null ? Number(r.avg_product_price) : null, (r.currency as string) ?? null, (r.country as string) ?? null);
    return [r.domain, r.name, r.category, r.country, r.city, r.platform, r.activity_tier, r.activity_score,
      r.hosting_provider, r.platform_version, r.theme, r.product_count, aov == null ? null : Math.round(aov),
      sales, revenueBand(sales), r.plus, r.email, r.contact_type, r.contact_name, r.contact_role,
      r.whatsapp, r.contact_phone, r.contact_form_url,
      r.contact_mx_ok == null ? null : (r.contact_mx_ok ? "yes" : "no — no MX, will bounce"),
      r.contact_mx_provider, r.contact_shared_count, r.contact_email_guess, r.contact_guess_status,
      r.payments, shipMerged(r.shipping_providers, r.logistics_apps), appSlugs(r.apps),
      r.plugins, r.technologies, r.instagram, r.facebook, r.tiktok, r.linkedin] as ExportCell[];
  });
  return { header, rows };
}

export async function browseExportCsv(f: BrowseFilters = {}): Promise<string> {
  const { header, rows } = await browseExportRows(f);
  const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [header.join(","), ...rows.map((row) => row.map(esc).join(","))].join("\n");
}
