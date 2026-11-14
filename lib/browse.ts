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
import { usdSqlExpr, usdExpr, bandSqlExpr, revenueBand, toUsd, type RevenueBand } from "./fx.ts";
import { scoreExpr } from "./score.ts";
import { db as sharedDb } from "./db";
import { EMAIL_TOOLS, HARD_NOT_TRADING } from "./store-signals.ts";

// Shared pool (see lib/db.ts). This module previously created its own pool WITHOUT prepare:false —
// a latent bug on the Supabase transaction pooler (which rejects prepared statements). The shared
// pool sets prepare:false, so moving to it fixes that as well as the cold-start/connection cost.
function db() {
  return sharedDb();
}

// Markets surfaced to customers — kept in sync with lib/markets.ts VISIBLE_MARKETS (the canonical
// source). Inlined here rather than imported so standalone scripts that load this module under raw
// Node don't choke on the "@/" path alias. Expanded ZA/KE/NG → all of Africa 2026-10-29.
const VISIBLE_MARKETS = [
  "ZA", "KE", "NG", "EG", "MA", "GH", "TZ", "UG", "DZ", "TN", "CI", "SN", "MU", "MZ",
  "CM", "BW", "AO", "NA", "RW", "ZM", "ET", "ZW", "LY", "MW", "SO", "LS", "SZ",
] as const;

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
  /** PLAN SCOPE — the platforms the subscriber's plan permits. Distinct from `platform`,
   *  which is the user's own filter: this one is a ceiling they cannot widen, injected
   *  server-side from the subscriber. Leave undefined for admin/unscoped reads. */
  planPlatforms?: string[];
  band?: string[]; theme?: string[]; city?: string[];
  payment?: string[]; shipping?: string[]; app?: string[]; plugin?: string[]; tech?: string[];
  activity?: string[]; hosting?: string[];
  /** DNS (store_dns, scripts/dns-tech.mjs): the mailbox provider behind the store's MX, and tools
   *  seen in its SPF/DKIM/verification records (Klaviyo, HubSpot, Zendesk …). */
  emailProvider?: string[]; dnsTool?: string[];
  /** Checkout-probe "not trading" reasons (store_not_trading): show only stores with these reasons… */
  notTrading?: string[];
  /** …or hide the stores that are definitely not trading (frozen, password page, not accepting orders). */
  hideNotTrading?: boolean;
  plus?: boolean; hasEmail?: boolean; noPayment?: boolean;
  /** Contact-quality facet: 'named' | 'role_targeted' | 'role_generic' | 'form_only' | 'none'. */
  contactType?: string[];
  /** Shorthand for the filter customers actually want: an address that reaches a person
   *  AND can actually receive mail. */
  reachableContact?: boolean;
  /** Drop addresses whose domain publishes no MX — the bounce list. */
  deliverable?: boolean;
  tier?: "top100" | "top500";
  /** Store groups (scripts/build-store-groups.mjs): `grouped` = stores whose operator runs other
   *  stores too; `group` = every store in one group (the drawer's "show all"). */
  grouped?: boolean; group?: string;
  domains?: string[];         // explicit selection (export the ticked rows), overrides the broad filter
  launchedDays?: number;      // launched within N days
  discoveredDays?: number;    // we first tracked it within N days
  status?: "migrated" | "dead"; // show stores in this terminal state (overrides the default live-only filter)
  checkedDays?: number;       // ...whose status was confirmed within N days (pairs with `status`)
  /** Replatformed within N days — stores that MOVED platform and are still trading, dated by
   *  migrated_at (when they left) rather than by when we noticed. Unlike `status: "migrated"`,
   *  this is an ordinary filter over LIVE leads: a confirmed move now heals `platform` and returns
   *  the store to active, so these rows sit in the normal lead universe and combine with every
   *  other facet — payments, contact quality, revenue band. That combination is the point: a store
   *  that just replatformed is re-choosing its payment provider, its apps and its agency. */
  migratedDays?: number;
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
  contactType: string | null; contactName: string | null; contactRole: string | null; whatsapp: string | null;
  /** Best-guess personal email for a named decision-maker (first@domain) + its status. Shown tagged
   *  "pending" until verified — never promoted into `email`/contact_email. */
  contactEmailGuess: string | null; contactGuessStatus: string | null;
  /** false = the address's domain has no MX and will bounce; null = not checked yet.
   *  sharedCount > 1 = another tracked store uses this same address (agency / head office). */
  contactMxOk: boolean | null; contactSharedCount: number | null;
  launchedAt: string | null; discoveredAt: string | null;
  top100: boolean; top500: boolean;
  /** The store's group when its operator runs other stores (null otherwise): id for the
   *  group filter, sites = how many stores one conversation covers. */
  groupId: string | null; groupSites: number | null;
  /** CrUX traffic-rank bucket (1000 = top 1k, lower is bigger) and the CrUX month it came from,
   *  so the table can show both the ranking and how fresh it is. `cruxTrend` is the move since
   *  the previous month we hold: up | down | flat | new. */
  cruxRank: number | null; cruxRankMonth: string | null; cruxTrend: string | null;
  /** Why the checkout probe found nothing to buy (frozen, password_page, …), or null. */
  notTrading: string | null;
  score: number;
};

export type Facet = { value: string; count: number }[];

export type BrowseStats = {
  plus: number; email: number; reachable: number; willBounce: number;
  /** Distinct operators behind the filtered set (a store group counts once): "500 stores, N
   *  conversations". Undefined on aggregates cached before it shipped. */
  operators?: number;
};

export type BrowseResult = {
  rows: BrowseRow[];
  total: number;              // true count for the current filters
  universe: number;           // true count with no filters at all
  // Live-stat tiles — true over the whole filtered set, not just the page.
  stats: BrowseStats;
  facets: {
    country: Facet; platform: Facet; band: Facet; contactType: Facet;
    category: Facet; city: Facet; theme: Facet;
    activity: Facet; hosting: Facet;
    payment: Facet; shipping: Facet; apps: Facet; plugins: Facet; tech: Facet;   // multi-token (a store has several)
    emailProvider: Facet; dnsTool: Facet; notTrading: Facet;   // side tables: store_dns, store_not_trading
  };
  recency: {
    launched: Record<number, number>;
    discovered: Record<number, number>;
  };
};

// Stores that belong to a real multi-store operator (review-flagged groups are hidden, as in
// lib/store-groups.ts). GROUP_JOIN exposes g_id / g_sites — names that can't collide with an
// imported_stores column the shared WHERE refers to. A join, not a per-row subquery: the
// correlated form cost ~8s on the full-table aggregate, the join ~0.
const GROUPED_SET = `(SELECT m.domain FROM store_group_members m JOIN store_groups g ON g.group_id = m.group_id
  WHERE NOT g.review AND g.n_sites > 1)`;
const GROUP_JOIN = `LEFT JOIN (SELECT m.domain AS g_domain, g.group_id AS g_id, g.n_sites AS g_sites
  FROM store_group_members m JOIN store_groups g ON g.group_id = m.group_id
  WHERE NOT g.review AND g.n_sites > 1) grp ON grp.g_domain = imported_stores.domain`;

const d = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 10) : null);

// Side tables keyed by domain, each created by its own script's explicit --migrate (never here):
// store_dns by scripts/dns-tech.mjs, store_not_trading by scripts/sync-checkout-payments.mjs. Detail
// data stays out of imported_stores, which is too hot to ALTER. Reads are index lookups: a LATERAL
// primary-key lookup per row for the facets, EXISTS for the filters (PK, the GIN index on tools, the
// btree on email_provider) — never a scan of store_dns, which covers every published store worldwide.
// Until a table exists the browse leaves it out, so deploying before the migration can't break a page.
type SideTables = { dns: boolean; nt: boolean };
const NO_SIDE: SideTables = { dns: false, nt: false };
let _side: { at: number; v: SideTables } | null = null;
export async function sideTables(): Promise<SideTables> {
  // Re-check every 30 min once both exist; every minute while one is still missing.
  if (_side && Date.now() - _side.at < (_side.v.dns && _side.v.nt ? 30 : 1) * 60_000) return _side.v;
  try {
    const [r] = await db()<{ dns: boolean; nt: boolean }[]>`
      SELECT to_regclass('public.store_dns') IS NOT NULL AS dns, to_regclass('public.store_not_trading') IS NOT NULL AS nt`;
    _side = { at: Date.now(), v: { dns: Boolean(r?.dns), nt: Boolean(r?.nt) } };
  } catch {
    return _side?.v ?? NO_SIDE;
  }
  return _side.v;
}
// One PK lookup per row. OFFSET 0 keeps the planner from flattening it into a hash join, which
// seq-scans the whole side table (store_dns covers every published store worldwide and grows
// ~60k rows an hour; the browse universe is ~90k). Measured on prod 2026-11-13: +~200ms per
// aggregate over the full visible set, vs a full scan of store_dns for the hash join.
const DNS_LATERAL = `LEFT JOIN LATERAL (SELECT sd.email_provider AS dns_email, sd.tools AS dns_tools, sd.verified AS dns_verified
  FROM store_dns sd WHERE sd.domain = imported_stores.domain OFFSET 0) dns ON true`;
const NT_LATERAL = `LEFT JOIN LATERAL (SELECT nt.reason AS nt_reason
  FROM store_not_trading nt WHERE nt.domain = imported_stores.domain OFFSET 0) ntr ON true`;
const DNS_NULLS = "NULL::text AS dns_email, NULL::text[] AS dns_tools, NULL::text[] AS dns_verified";
const textArray = (xs: readonly string[]) => `ARRAY[${xs.map((x) => `'${x.replace(/'/g, "''")}'`).join(",")}]::text[]`;

function buildWhere(f: BrowseFilters, side: SideTables = NO_SIDE) {
  const sql = db();
  const launchExpr = sql.unsafe(
    `COALESCE((CASE WHEN first_product_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN left(first_product_at,10)::date END), (CASE WHEN launched_source IS DISTINCT FROM 'cert' THEN launched_at END))`,
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
  // Plan scope first, as a hard ceiling. Applied even when the user sets no platform
  // filter, so a Shopify-only subscriber can never reach the 32,027 WooCommerce rows that
  // Partner pays for — including via a hand-crafted query string.
  if (f.planPlatforms?.length) conds.push(sql`platform = ANY(${f.planPlatforms})`);
  // The user's own filter narrows WITHIN that ceiling; intersecting rather than replacing
  // means ?platform=WooCommerce from a Leads account yields nothing, not everything.
  if (f.platform?.length) {
    const allowed = f.planPlatforms?.length
      ? f.platform.filter((p) => f.planPlatforms!.some((a) => a.toLowerCase() === p.toLowerCase()))
      : f.platform;
    // An entirely out-of-scope request must return no rows, not fall through unfiltered.
    conds.push(allowed.length ? sql`platform = ANY(${allowed})` : sql`false`);
  }
  if (f.category?.length) conds.push(sql`category = ANY(${f.category})`);
  if (f.city?.length) conds.push(sql`city = ANY(${f.city})`);
  if (f.theme?.length) conds.push(sql`btrim(theme) ILIKE ANY(${f.theme})`);
  if (f.band?.length) conds.push(sql`${sql.unsafe(bandSqlExpr())} = ANY(${f.band})`);
  if (f.payment?.length) conds.push(sql`payments ILIKE ANY(${f.payment.map((p) => `%${p}%`)})`);
  if (f.shipping?.length) conds.push(sql`shipping_providers ILIKE ANY(${f.shipping.map((s) => `%${s}%`)})`);
  if (f.app?.length) conds.push(sql`apps ILIKE ANY(${f.app.map((a) => `%${a}%`)})`);
  if (f.plugin?.length) conds.push(sql`plugins ILIKE ANY(${f.plugin.map((a) => `%${a}%`)})`);
  // Cross-platform tech facet — `technologies` carries clean vendor names for every CMS (Klaviyo,
  // Gorgias, PayFast…), unlike apps (Shopify-only) / plugins (Woo-only). This is the filter that
  // reaches a vendor's whole footprint across platforms.
  if (f.tech?.length) conds.push(sql`technologies ILIKE ANY(${f.tech.map((a) => `%${a}%`)})`);
  if (f.activity?.length) conds.push(sql`activity_tier = ANY(${f.activity})`);
  if (f.hosting?.length) conds.push(sql`hosting_provider = ANY(${f.hosting})`);
  // DNS + not-trading filters are EXISTS against the side table's primary key (plus the GIN index on
  // store_dns.tools / the btree on email_provider), so the planner can drive either way, by index.
  // A filter on a table that doesn't exist yet matches nothing rather than everything.
  if (f.emailProvider?.length) conds.push(side.dns
    ? sql`EXISTS (SELECT 1 FROM store_dns sd WHERE sd.domain = imported_stores.domain AND sd.email_provider = ANY(${f.emailProvider}))`
    : sql`false`);
  if (f.dnsTool?.length) conds.push(side.dns
    ? sql`EXISTS (SELECT 1 FROM store_dns sd WHERE sd.domain = imported_stores.domain AND sd.tools && ${f.dnsTool}::text[])`
    : sql`false`);
  if (f.notTrading?.length) conds.push(side.nt
    ? sql`EXISTS (SELECT 1 FROM store_not_trading nt WHERE nt.domain = imported_stores.domain AND nt.reason = ANY(${f.notTrading}))`
    : sql`false`);
  if (f.hideNotTrading && side.nt) {
    conds.push(sql`NOT EXISTS (SELECT 1 FROM store_not_trading nt WHERE nt.domain = imported_stores.domain AND nt.reason = ANY(${HARD_NOT_TRADING}))`);
  }
  if (f.plus) conds.push(sql`plus`);
  if (f.hasEmail) conds.push(sql`${sql.unsafe(bestEmailSql)} IS NOT NULL AND ${sql.unsafe(bestEmailSql)} <> ''`);
  if (f.migratedDays) conds.push(sql`migrated_at >= now() - ${f.migratedDays}::int * interval '1 day'`);
  if (f.contactType?.length) conds.push(sql`contact_type = ANY(${f.contactType})`);
  if (f.reachableContact) conds.push(sql`contact_type = ANY(${[...REACHABLE_TYPES]}) AND ${sql.unsafe(DELIVERABLE)}`);
  if (f.deliverable) conds.push(sql.unsafe(DELIVERABLE));
  if (f.noPayment) conds.push(sql`payments_checked_at IS NOT NULL AND (payments IS NULL OR payments = '')`);
  if (f.grouped) conds.push(sql.unsafe(`domain IN ${GROUPED_SET}`));
  if (f.group) conds.push(sql`domain IN (SELECT domain FROM store_group_members WHERE group_id = ${f.group})`);
  if (f.tier) conds.push(sql`domain IN (SELECT domain FROM store_tags WHERE tag = ${f.tier === "top100" ? "top-100" : "top-500"})`);
  if (f.launchedDays) conds.push(sql`${launchExpr} >= CURRENT_DATE - ${f.launchedDays}::int`);
  if (f.discoveredDays) conds.push(sql`discovered_at >= CURRENT_DATE - ${f.discoveredDays}::int`);
  return conds.reduce((a, c) => sql`${a} AND ${c}`);
}

// Revenue sorts read REV — the SAME expression the Revenue column displays and the bands and facet
// counts use (revExpr in lib/fx.ts: ballpark-first, FX-normalised to USD). Ordering by the raw
// `estimated_monthly_sales` column instead was wrong twice over: it is LOCAL currency, so a R20m
// store beat a $700k one on the bare number across 78 currencies, and it is present on only 37% of
// customer-visible rows — the 54,002 stores that display a band off `revenue_ballpark_usd` sorted as
// NULL and sank to the bottom. Measured before this fix: 41 of the top 50 rows were the wrong store.
const REV = usdSqlExpr();
// Ballpark values are CrUX BUCKETS, so ties are enormous (52,389 visible stores share $683) and the
// bucket alone leaves page 1 arbitrary. The FX-normalised vendor estimate refines within a bucket,
// putting the better-evidenced big stores first; `domain` then makes each order TOTAL, which matters
// because LIMIT/OFFSET paging over a tied order can serve one row on two pages and another on none.
// Every entry below is self-sufficient, so the export can reuse one directly.
const TIE = `${usdExpr("estimated_monthly_sales")} DESC NULLS LAST, domain ASC`;

const ORDER: Record<SortKey, string> = {
  // Default view: most-recently-discovered first (the primary driver). Pure discovered_at DESC, so
  // today's live CT finds lead page 1; revenue breaks ties within a day's batch. A blended "new in
  // last N days then by revenue" was useless here — ~84% of rows were stamped this month by bulk
  // imports, so the window didn't discriminate and it collapsed back to a revenue sort.
  new: `discovered_at DESC NULLS LAST, ${REV} DESC NULLS LAST, ${TIE}`,
  sales: `${REV} DESC NULLS LAST, ${TIE}`,
  name: "COALESCE(name, domain) ASC, domain ASC",
  launched: `launched_on DESC NULLS LAST, ${TIE}`,
  discovered: `discovered_at DESC NULLS LAST, ${TIE}`,
  // the real lead-fit score (SQL), so non-Shopify ranks on merit not just revenue
  score: `(${scoreExpr()}) DESC, ${TIE}`,
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
  stats: BrowseStats;
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
//
// The serve-stale window MUST exceed the gap between warm runs, or keys expire and every cold
// instance pays the live scan again — the exact "dashboard won't load" outage. The dependable warmer
// is the Vercel cron (/api/cron/refresh-browse), which self-authenticates and runs daily at 09:00;
// the 30-min launchd curl is a bonus that needs the fleet's CRON_SECRET to match prod. Since the
// expanded VISIBLE_MARKETS (27 countries, ~112k rows) made the cold scan heavy enough to time out on
// a user request, we size this to comfortably outlast the DAILY cron so an already-computed key is
// always served from cache (counts up to ~a day stale; write-through keeps active keys fresher). If
// the warm cadence ever goes sub-daily again, this can come back down.
const BROWSE_CACHE_TTL = "26 hours";     // serve-stale window; must exceed the daily warm-cron gap
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
  const side = await sideTables();
  const where = buildWhere(f, side);
  const usd = sql.unsafe(usdSqlExpr());
  const band = sql.unsafe(bandSqlExpr());
  // The Apps facet is a regex over every row's app-store URLs — the single most expensive sub-query.
  // Apps exist only on Shopify stores and the UI only shows the Apps facet when Shopify is selected,
  // so compute it ONLY then; otherwise return an empty facet and skip the scan.
  const wantApps = f.platform?.some((p) => p.toLowerCase() === "shopify") ?? false;
  const launchSel = sql.unsafe(
    `COALESCE((CASE WHEN first_product_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN left(first_product_at,10)::date END), (CASE WHEN launched_source IS DISTINCT FROM 'cert' THEN launched_at END)) AS launched_on`,
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

  // DNS tools minus the mailbox providers, which have their own facet (Email provider).
  const dnsToolFacet =
    `(SELECT COALESCE(jsonb_agg(jsonb_build_array(v, n) ORDER BY n DESC), '[]'::jsonb)
        FROM (SELECT tok AS v, count(*)::int n FROM f, unnest(f.dns_tools) AS tok
              WHERE tok <> ALL(${textArray(EMAIL_TOOLS)}) GROUP BY 1 ORDER BY n DESC LIMIT 40) t)`;

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
             payments, shipping_providers, apps, plugins, technologies, plus, contact_type,
             (${sql.unsafe(bestEmailSql)} IS NOT NULL AND ${sql.unsafe(bestEmailSql)} <> '') AS has_email,
             (contact_type = ANY(${[...REACHABLE_TYPES]}) AND ${sql.unsafe(DELIVERABLE)}) AS reachable,
             (contact_mx_ok IS FALSE) AS will_bounce,
             COALESCE((CASE WHEN first_product_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN left(first_product_at,10)::date END), (CASE WHEN launched_source IS DISTINCT FROM 'cert' THEN launched_at END)) AS launched_on,
             discovered_at,
             COALESCE(g_id, domain) AS operator,
             ${sql.unsafe(side.dns ? "dns.dns_email, dns.dns_tools" : "NULL::text AS dns_email, NULL::text[] AS dns_tools")},
             ${sql.unsafe(side.nt ? "ntr.nt_reason" : "NULL::text AS nt_reason")}
      FROM imported_stores ${sql.unsafe(GROUP_JOIN)}
        ${sql.unsafe(side.dns ? DNS_LATERAL : "")} ${sql.unsafe(side.nt ? NT_LATERAL : "")}
      WHERE ${where}
    )
    SELECT (SELECT count(*)::int FROM f) AS total,
           (SELECT (count(*) FILTER (WHERE plus))::int FROM f)       AS c_plus,
           (SELECT (count(*) FILTER (WHERE has_email))::int FROM f)  AS c_email,
           (SELECT (count(*) FILTER (WHERE reachable))::int FROM f)   AS c_reachable,
           (SELECT (count(*) FILTER (WHERE will_bounce))::int FROM f) AS c_bounce,
           (SELECT count(DISTINCT operator)::int FROM f)              AS c_operators,
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
           ${sql.unsafe(multiFacet("technologies"))} AS f_tech,
           ${sql.unsafe(facetSub("dns_email"))}     AS f_email_provider,
           ${sql.unsafe(dnsToolFacet)}              AS f_dns_tool,
           ${sql.unsafe(facetSub("nt_reason"))}     AS f_not_trading,
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
      stats: { plus: Number(agg.c_plus ?? 0), email: Number(agg.c_email ?? 0), reachable: Number(agg.c_reachable ?? 0), willBounce: Number(agg.c_bounce ?? 0), operators: Number(agg.c_operators ?? 0) },
      facets: {
        country: toFacet(agg.f_country), platform: toFacet(agg.f_platform),
        band: toFacet(agg.f_band), category: toFacet(agg.f_category), contactType: toFacet(agg.f_contact),
        city: toFacet(agg.f_city), theme: toFacet(agg.f_theme),
        activity: toFacet(agg.f_activity), hosting: toFacet(agg.f_hosting),
        payment: toFacet(agg.f_payment), shipping: toFacet(agg.f_shipping), apps: toFacet(agg.f_apps), plugins: toFacet(agg.f_plugins), tech: toFacet(agg.f_tech),
        emailProvider: toFacet(agg.f_email_provider), dnsTool: toFacet(agg.f_dns_tool), notTrading: toFacet(agg.f_not_trading),
      },
      recency: { launched: toRec(agg.r_launched), discovered: toRec(agg.r_discovered) },
    };
    _aggCache.set(key, { at: Date.now(), v: A });
    void dbAggSet(sql, key, A);   // write-through so the next cold instance reads it back instead of re-scanning
  }

  const rows = await sql<Record<string, unknown>[]>`
    SELECT domain, name, category, country, city, platform, btrim(theme) AS theme, plus,
           activity_tier, ${sql.unsafe(bestEmailSql)} AS email,
           contact_type, contact_name, contact_role, contact_email_guess, contact_guess_status, whatsapp, contact_mx_ok, contact_shared_count,
           migrated_from, migrated_at,
           instagram, facebook, tiktok,
           instagram_followers, facebook_followers, product_count, avg_product_price, currency,
           ${usd}::int AS usd, ${sql.unsafe(scoreExpr())} AS fit_score, discovered_at, ${launchSel},
           crux_rank, crux_rank_month, crux_trend,
           (domain IN (SELECT domain FROM store_tags WHERE tag='top-100')) AS top100,
           (domain IN (SELECT domain FROM store_tags WHERE tag='top-500')) AS top500,
           g_id AS grp_id, g_sites AS grp_sites,
           ${side.nt ? sql`(SELECT nt.reason FROM store_not_trading nt WHERE nt.domain = imported_stores.domain)` : sql`NULL::text`} AS nt_reason
    FROM imported_stores ${sql.unsafe(GROUP_JOIN)}
    WHERE ${where}
    ORDER BY ${order}
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
        migratedFrom: (r.migrated_from as string) ?? null,
        migratedAt: r.migrated_at ? new Date(r.migrated_at as string).toISOString().slice(0, 10) : null,
        contactType: (r.contact_type as string) ?? null, contactName: (r.contact_name as string) ?? null,
        contactRole: (r.contact_role as string) ?? null,
        contactEmailGuess: (r.contact_email_guess as string) ?? null, contactGuessStatus: (r.contact_guess_status as string) ?? null,
        whatsapp: (r.whatsapp as string) ?? null,
        contactMxOk: r.contact_mx_ok == null ? null : Boolean(r.contact_mx_ok),
        contactSharedCount: r.contact_shared_count == null ? null : Number(r.contact_shared_count),
        launchedAt: d(r.launched_on ? String(r.launched_on) : null),
        discoveredAt: d(r.discovered_at ? String(r.discovered_at) : null),
        top100: !!r.top100, top500: !!r.top500,
        groupId: (r.grp_id as string) ?? null, groupSites: r.grp_sites == null ? null : Number(r.grp_sites),
        cruxRank: r.crux_rank == null ? null : Number(r.crux_rank),
        cruxRankMonth: (r.crux_rank_month as string) ?? null,
        cruxTrend: (r.crux_trend as string) ?? null,
        notTrading: (r.nt_reason as string) ?? null,
        score: Number(r.fit_score) || 0,
      };
    }),
    // Defaults for aggregates cached (browse_cache, up to 26h) before a facet shipped.
    facets: { ...A.facets, tech: A.facets.tech ?? [], emailProvider: A.facets.emailProvider ?? [], dnsTool: A.facets.dnsTool ?? [], notTrading: A.facets.notTrading ?? [] },
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
  const side = await sideTables();
  const where = buildWhere(f, side);
  const usd = sql.unsafe(usdSqlExpr());
  const band = sql.unsafe(bandSqlExpr());
  const out = await sql<Record<string, unknown>[]>`
    SELECT domain, name, category, country, city, platform, activity_tier, activity_score,
           hosting_provider, platform_version, btrim(theme) AS theme, product_count, avg_product_price,
           currency, ${usd}::int AS usd, ${band} AS band, plus,
           ${sql.unsafe(bestEmailSql)} AS email, contact_type, contact_name, contact_role,
           whatsapp, contact_phone, contact_form_url, contact_mx_ok, contact_mx_provider,
           contact_shared_count, contact_email_guess, contact_guess_status, payments, shipping_providers,
           logistics_apps, apps, plugins, technologies, instagram, facebook, tiktok, linkedin,
           price_min, price_max, products_sold, plan AS shopify_plan, description,
           instagram_followers, facebook_followers, first_product_at, first_seen,
           migrated_from, migrated_at,
           ${sql.unsafe(side.dns ? "dns.dns_email, dns.dns_tools, dns.dns_verified" : DNS_NULLS)},
           ${sql.unsafe(side.nt ? "ntr.nt_reason" : "NULL::text AS nt_reason")}
    FROM imported_stores ${sql.unsafe(side.dns ? DNS_LATERAL : "")} ${sql.unsafe(side.nt ? NT_LATERAL : "")}
    WHERE ${where}
    ORDER BY ${sql.unsafe(ORDER.sales)}
    LIMIT ${EXPORT_CAP}`;
  // Shopify add-ons live in `apps` (apps.shopify.com slugs); every other CMS exposes them as `plugins`
  // (wp-content/plugins, /modules/…) + cross-platform third-party `technologies` (Klaviyo, Gorgias, …).
  // Normalise `apps` to bare slugs so the column reads the same across platforms.
  const appSlugs = (s: unknown) => String(s ?? "").match(/apps\.shopify\.com\/([a-z0-9][a-z0-9-]*)/gi)?.map((u) => u.split("/").pop()).join("; ") || null;
  // `shipping_providers` is the Shopify checkout read; `logistics_apps` is the cross-platform homepage
  // carrier fingerprint (Bob Go, Pargo, TUNL…). Merge them so non-Shopify stores show shipping too.
  const shipMerged = (a: unknown, b: unknown) => [...new Set(`${a ?? ""};${b ?? ""}`.split(";").map((x) => x.trim()).filter(Boolean))].join("; ") || null;
  // `date` columns arrive as Date objects from postgres.js; a raw Date stringifies to the
  // full locale form, which spreadsheets then refuse to sort. Emit plain ISO days.
  const list = (v: unknown) => (Array.isArray(v) && v.length ? v.join("; ") : null);
  const dayCell = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
  // contact_type is exported next to the address on purpose: a CSV of bare emails is exactly the
  // artefact customers complain about, because nothing in it says which rows are worth a send.
  // price_min/price_max/currency are the NATIVE-currency catalogue spread; aov_usd is the
  // normalised one. Both ship: the native pair is what a merchant recognises, the USD one is
  // what sorts across markets. shopify_plan is the plan-tier ladder (see the plan-detection
  // work), not Terrain's subscription plan.
  const header = ["domain", "name", "category", "country", "city", "platform", "activity_tier", "activity_score", "hosting", "platform_version", "theme", "product_count", "price_min", "price_max", "currency", "aov_usd", "est_monthly_sales_usd", "products_sold", "revenue_band", "plus", "shopify_plan", "email", "contact_type", "contact_name", "contact_role", "whatsapp", "phone", "contact_form", "deliverable", "mail_provider", "shared_with_n_stores", "likely_personal_email_INFERRED", "inferred_status", "payments", "shipping", "apps", "plugins", "technologies", "instagram", "instagram_followers", "facebook", "facebook_followers", "tiktok", "linkedin", "description", "first_product_at", "first_seen", "migrated_from", "migrated_at", "email_provider", "dns_tools", "dns_verified", "not_trading"];
  const rows: ExportCell[][] = out.map((r) => {
    const sales = r.usd == null ? null : Number(r.usd);
    const aov = toUsd(r.avg_product_price != null ? Number(r.avg_product_price) : null, (r.currency as string) ?? null, (r.country as string) ?? null);
    return [r.domain, r.name, r.category, r.country, r.city, r.platform, r.activity_tier, r.activity_score,
      r.hosting_provider, r.platform_version, r.theme, r.product_count,
      r.price_min == null ? null : Number(r.price_min), r.price_max == null ? null : Number(r.price_max), r.currency,
      aov == null ? null : Math.round(aov),
      sales, r.products_sold == null ? null : Number(r.products_sold), revenueBand(sales), r.plus, r.shopify_plan,
      r.email, r.contact_type, r.contact_name, r.contact_role,
      r.whatsapp, r.contact_phone, r.contact_form_url,
      r.contact_mx_ok == null ? null : (r.contact_mx_ok ? "yes" : "no — no MX, will bounce"),
      r.contact_mx_provider, r.contact_shared_count, r.contact_email_guess, r.contact_guess_status,
      r.payments, shipMerged(r.shipping_providers, r.logistics_apps), appSlugs(r.apps),
      r.plugins, r.technologies,
      r.instagram, r.instagram_followers == null ? null : Number(r.instagram_followers),
      r.facebook, r.facebook_followers == null ? null : Number(r.facebook_followers),
      r.tiktok, r.linkedin,
      r.description, dayCell(r.first_product_at), dayCell(r.first_seen),
      r.migrated_from, dayCell(r.migrated_at),
      r.dns_email, list(r.dns_tools), list(r.dns_verified), r.nt_reason] as ExportCell[];
  });
  // Header and row width drift silently — two lists kept in one order by hand. Catch it here
  // rather than in a customer's spreadsheet.
  if (rows.length && rows[0].length !== header.length) {
    throw new Error(`export column drift: ${header.length} headers, ${rows[0].length} cells`);
  }
  return { header, rows };
}

/** Serialise already-fetched rows. Separate from browseExportCsv so a caller that needs the
 *  exact row COUNT (export metering) can count rows rather than counting newlines — a cell
 *  holding a newline, which `description` routinely does, makes a line count wrong. */
export function toCsv(header: string[], rows: ExportCell[][]): string {
  const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [header.join(","), ...rows.map((row) => row.map(esc).join(","))].join("\n");
}

export async function browseExportCsv(f: BrowseFilters = {}): Promise<string> {
  const { header, rows } = await browseExportRows(f);
  return toCsv(header, rows);
}
