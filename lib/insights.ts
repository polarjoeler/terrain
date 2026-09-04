/** Market Insights, computed live from the Postgres store universe
 *  (imported_stores) — NOT the old shopify-radar Sheet snapshot (which only
 *  counted ~700 discovery-engine stores). This unifies /insights with the rest
 *  of the app and gives absolute counts + every provider/theme/app/category, so
 *  the UI can drill in. Daily snapshots (insights_snapshots) power the trends.
 */

import postgres from "postgres";
import { classify, cleanPayments, canonicalProvider, PAY_TYPES, type PayType } from "./payments-taxonomy";
import { VISIBLE_MARKETS } from "./markets";

let _sql: ReturnType<typeof postgres> | null = null;
function db() {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL not set");
    _sql = postgres(url, { prepare: false, max: 3, idle_timeout: 20 });
  }
  return _sql;
}

export type InsightItem = { label: string; count: number; pct: number };

export type InsightsData = {
  date: string;
  storesTotal: number;
  newThisWeek: number;
  // Organic stores discovered within each trailing window (excludes imports) —
  // powers the daily/weekly "increase" on the stores-tracked tile.
  discoveredByPeriod: { day: number; week: number; month: number; quarter: number; year: number };
  plusTotal: number;
  plusNewThisWeek: number;
  paymentsVerifiedStores: number;
  paymentsByProvider: InsightItem[];
  paymentsByType: Record<PayType, InsightItem>;
  firstProvider: InsightItem[];
  themes: InsightItem[];
  themesKnown: number;
  categories: InsightItem[];
  categoriesKnown: number;
  cities: InsightItem[];
  citiesKnown: number;
  apps: InsightItem[];
  appsKnown: number;
  shippingByProvider: InsightItem[];
  shippingKnown: number;      // stores with a verified shipping provider
  freeShippingStores: number; // of those, how many offer free shipping
  churn: {
    total: number;
    checked: number;
    active: number;
    migrated: number;
    dead: number;
    survival: number | null;
  };
};

const pct = (n: number, denom: number) => (denom > 0 ? Math.round((100 * n) / denom) : 0);

// App identifiers arrive as Shopify app-store URLs — show the readable slug.
const prettyApp = (s: string) =>
  s.replace(/https?:\/\/apps\.shopify\.com\//g, "").replace(/^https?:\/\//, "").replace(/[-_]/g, " ").trim();
const items = (rows: { label: string; n: number }[], denom: number): InsightItem[] =>
  rows.filter((r) => r.label).map((r) => ({ label: r.label, count: r.n, pct: pct(r.n, denom) }));

// "Brand New Stores" = discovered (cert-transparency found) in this window.
export const NEW_STORE_DAYS = 90;

// A cohort filter fragment: undefined = all; "new" = recently discovered
// (dynamic); anything else = a curated store_tags cohort (Top 100 etc.).
const cohortFilter = (tag?: string) =>
  !tag
    ? db()``
    : tag === "new"
      ? db()`AND discovered_at IS NOT NULL AND discovered_at >= CURRENT_DATE - (${NEW_STORE_DAYS}::int * INTERVAL '1 day')`
      : db()`AND domain IN (SELECT domain FROM store_tags WHERE tag = ${tag})`;

// Published live stores for a market — the universe the insights describe.
// An optional cohort tag narrows it (Top 100, Brand New, …).
const LIVE = (country: string, tag?: string) =>
  db()`published AND country = ${country}
       AND (live_status IS NULL OR live_status NOT IN ('dead', 'migrated'))
       ${cohortFilter(tag)}`;

/** Count of stores in a dynamic/curated cohort for a market — for the selector. */
export async function cohortCount(country: string, tag: string): Promise<number> {
  const [r] = await db()`SELECT COUNT(*)::int n FROM imported_stores WHERE ${LIVE(country, tag)}`;
  return Number(r?.n ?? 0);
}

/** Distinct markets with published live stores, most first — for the selector. */
export async function availableCountries(): Promise<{ country: string; stores: number }[]> {
  // Only the visible markets — the DB holds stores globally, but the pickers (and thus
  // insights + the dashboard) offer just these until we launch more.
  const rows = await db()<{ country: string; n: number }[]>`
    SELECT country, COUNT(*)::int n FROM imported_stores
    WHERE published AND country = ANY(${[...VISIBLE_MARKETS]})
      AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
    GROUP BY country ORDER BY n DESC`;
  return rows.map((r) => ({ country: r.country, stores: Number(r.n) }));
}

// The insights page fires ~a dozen aggregate queries; it's identical for every
// viewer of a given (country, tag) and only shifts as enrichment trickles in, so
// we cache each result in-process with a short TTL. First hit for a key computes;
// everyone else within the window is instant. An in-flight guard collapses a
// stampede on a cold/expired key. (Module scope persists in a warm server
// instance; a cold start recomputes once.)
type CachedInsights = { at: number; data: InsightsData };
// Canonicalise a raw checkout shipping token → a clean carrier name, or null to DROP.
// Merges duplicate variants (tunl shipping / tunl shipping rates → TUNL), removes
// Shopify's own generic layer (not a real carrier), and drops rate-calculation apps
// and custom "carrier service" entries that aren't actual carriers.
const CARRIER_CANON: [RegExp, string][] = [
  [/bob\s*go|bobgo/, "Bob Go"], [/tunl/, "TUNL"], [/pargo/, "Pargo"],
  [/courier\s*guy/, "The Courier Guy"], [/fastway/, "Fastway"], [/aramex/, "Aramex"],
  [/\bpaxi\b/, "Paxi"], [/\bpudo\b/, "Pudo"], [/skynet/, "Skynet"], [/\bram\b/, "RAM"],
  [/dhl/, "DHL"], [/fedex/, "FedEx"], [/\bups\b|ups_/, "UPS"], [/usps/, "USPS"],
  [/royal\s*mail/, "Royal Mail"], [/global[-\s]?e/, "Global-e"], [/passport/, "Passport"],
  [/zonos/, "Zonos"], [/shiprazor/, "Shiprazor"], [/sendcloud/, "Sendcloud"],
  [/shipstation/, "ShipStation"], [/easyship/, "Easyship"], [/uafrica/, "uAfrica"],
  [/parcel\s*perfect|parcelperfect/, "Parcel Perfect"],
];
// Tokens that are NOT carriers — Shopify's generic layer, rate-calc apps, custom rules.
const CARRIER_DROP = /shopify|generic|provided_layer|carrier service|shipping app|shipping rules?|advanced shipping|better shipping|postcode|parcelify|intuitive|shipeasy|shipping easy|collective|scrubbill|calculator|\bmatrix\b|custom|\brates?\b|table rate|flat rate|manual/;
function normalizeCarrier(raw: string): string | null {
  const s = raw.toLowerCase().trim();
  if (!s) return null;
  for (const [re, name] of CARRIER_CANON) if (re.test(s)) return name; // known carriers win first
  if (CARRIER_DROP.test(s)) return null;                                // then drop app/generic/custom noise
  return raw.trim().split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

const INSIGHTS_TTL_MS = 10 * 60 * 1000;
const _insightsCache = new Map<string, CachedInsights>();
const _insightsInflight = new Map<string, Promise<InsightsData>>();

export async function computeInsights(country = "ZA", tag?: string): Promise<InsightsData> {
  const key = `${country}|${tag ?? ""}`;
  const hit = _insightsCache.get(key);
  if (hit && Date.now() - hit.at < INSIGHTS_TTL_MS) return hit.data;
  let inflight = _insightsInflight.get(key);
  if (!inflight) {
    inflight = computeInsightsUncached(country, tag)
      .then((data) => {
        _insightsCache.set(key, { at: Date.now(), data });
        _insightsInflight.delete(key);
        return data;
      })
      .catch((e) => {
        _insightsInflight.delete(key);
        if (hit) return hit.data; // serve stale rather than error the page
        throw e;
      });
    _insightsInflight.set(key, inflight);
  }
  return inflight;
}

async function computeInsightsUncached(country = "ZA", tag?: string): Promise<InsightsData> {
  const sql = db();
  // Cohort filter (Top 100, Brand New, …) applied inside the flag subquery.
  const inTag = cohortFilter(tag);

  const [t] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE live)::int                                    AS stores_total,
      COUNT(*) FILTER (WHERE live AND plus)::int                           AS plus_total,
      COUNT(*) FILTER (WHERE live AND fresh)::int                          AS new_week,
      COUNT(*) FILTER (WHERE live AND plus AND fresh)::int                 AS plus_new_week,
      COUNT(*) FILTER (WHERE live AND payments IS NOT NULL AND payments <> '')::int AS verified,
      COUNT(*) FILTER (WHERE za)::int                                      AS churn_total,
      COUNT(*) FILTER (WHERE za AND live_checked_at IS NOT NULL)::int      AS churn_checked,
      COUNT(*) FILTER (WHERE za AND live_status = 'active')::int           AS churn_active,
      COUNT(*) FILTER (WHERE za AND live_status = 'migrated')::int         AS churn_migrated,
      COUNT(*) FILTER (WHERE za AND live_status = 'dead')::int             AS churn_dead,
      COUNT(*) FILTER (WHERE live AND theme IS NOT NULL AND theme <> '')::int      AS themes_known,
      COUNT(*) FILTER (WHERE live AND category IS NOT NULL)::int           AS categories_known,
      COUNT(*) FILTER (WHERE live AND city IS NOT NULL AND city <> '')::int        AS cities_known,
      COUNT(*) FILTER (WHERE live AND shipping_providers IS NOT NULL AND shipping_providers <> '')::int AS shipping_known,
      COUNT(*) FILTER (WHERE live AND free_shipping)::int                          AS free_shipping_stores,
      COUNT(*) FILTER (WHERE live AND apps IS NOT NULL AND apps <> '')::int        AS apps_known,
      -- Organic growth per period — discovered_at based, so bulk IMPORTS (which have
      -- discovered_at NULL) never inflate the daily/weekly "increase" on the tiles.
      COUNT(*) FILTER (WHERE live AND discovered_at >= CURRENT_DATE - 1)::int    AS disc_day,
      COUNT(*) FILTER (WHERE live AND discovered_at >= CURRENT_DATE - 7)::int    AS disc_week,
      COUNT(*) FILTER (WHERE live AND discovered_at >= CURRENT_DATE - 30)::int   AS disc_month,
      COUNT(*) FILTER (WHERE live AND discovered_at >= CURRENT_DATE - 91)::int   AS disc_quarter,
      COUNT(*) FILTER (WHERE live AND discovered_at >= CURRENT_DATE - 365)::int  AS disc_year
    FROM (
      SELECT *,
        (published AND country = ${country} ${inTag} AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))) AS live,
        (published AND country = ${country} ${inTag}) AS za,
        -- "new this week" = genuinely DISCOVERED by our engine in the last 7 days.
        -- Use discovered_at (set only by the CT discovery feed), NOT created_at:
        -- created_at also fires on bulk imports, so a backfill of old stores would
        -- spike this misleadingly. Imports have discovered_at NULL → excluded.
        (discovered_at IS NOT NULL AND discovered_at >= CURRENT_DATE - 7) AS fresh
      FROM imported_stores
    ) s`;

  const storesTotal = Number(t.stores_total);
  const themesKnown = Number(t.themes_known);
  const categoriesKnown = Number(t.categories_known);
  const citiesKnown = Number(t.cities_known);
  const appsKnown = Number(t.apps_known);

  // Per-store payments → provider share, type share (stores offering ≥1), and
  // first-listed provider (best-effort ordering from the checkout sync).
  const payRows = await sql`
    SELECT payments FROM imported_stores
    WHERE ${LIVE(country, tag)} AND payments IS NOT NULL AND payments <> ''`;
  const providerCount = new Map<string, number>();
  const firstCount = new Map<string, number>();
  const typeStores: Record<PayType, number> = { PSP: 0, BNPL: 0, APM: 0 };
  let verified = 0; // stores with ≥1 real provider after stripping wallet noise
  for (const r of payRows) {
    const gws = cleanPayments(String(r.payments).split(";"));
    if (!gws.length) continue;
    verified++;
    firstCount.set(gws[0], (firstCount.get(gws[0]) ?? 0) + 1);
    const seenTypes = new Set<PayType>();
    for (const g of gws) {
      providerCount.set(g, (providerCount.get(g) ?? 0) + 1);
      seenTypes.add(classify(g));
    }
    for (const ty of seenTypes) typeStores[ty]++;
  }
  const toSorted = (m: Map<string, number>) =>
    [...m.entries()].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n);

  const paymentsByType = {} as Record<PayType, InsightItem>;
  for (const ty of PAY_TYPES) paymentsByType[ty] = { label: ty, count: typeStores[ty], pct: pct(typeStores[ty], verified) };

  // Shipping providers (checkout-verified carrier/app), semicolon-separated.
  const shippingKnown = Number(t.shipping_known);
  const shipRows = await sql`
    SELECT shipping_providers FROM imported_stores
    WHERE ${LIVE(country, tag)} AND shipping_providers IS NOT NULL AND shipping_providers <> ''`;
  const shipCount = new Map<string, number>();
  for (const r of shipRows) {
    // Normalise + dedupe per store, so "tunl shipping;tunl shipping rates" counts TUNL
    // once and a Shopify-only store contributes no (real) carrier.
    const seen = new Set<string>();
    for (const raw of String(r.shipping_providers).split(";").map((x) => x.trim()).filter(Boolean)) {
      const name = normalizeCarrier(raw);
      if (name) seen.add(name);
    }
    for (const name of seen) shipCount.set(name, (shipCount.get(name) ?? 0) + 1);
  }

  // Sequential, NOT Promise.all: the db() pool is max:3, and firing several
  // concurrent queries after a prior awaited query can deadlock the ones that
  // queue beyond the pool (postgres.js). Sequential never exceeds the pool.
  type Agg = { label: string; n: number };
  const themes = await sql<Agg[]>`SELECT theme AS label, COUNT(*)::int n FROM imported_stores
        WHERE ${LIVE(country, tag)} AND theme IS NOT NULL AND theme <> '' GROUP BY theme ORDER BY n DESC`;
  const categories = await sql<Agg[]>`SELECT category AS label, COUNT(*)::int n FROM imported_stores
        WHERE ${LIVE(country, tag)} AND category IS NOT NULL GROUP BY category ORDER BY n DESC`;
  const cities = await sql<Agg[]>`SELECT city AS label, COUNT(*)::int n FROM imported_stores
        WHERE ${LIVE(country, tag)} AND city IS NOT NULL AND city <> '' GROUP BY city ORDER BY n DESC`;
  const apps = await sql<Agg[]>`SELECT app AS label, COUNT(*)::int n FROM (
          SELECT trim(unnest(string_to_array(apps, ';'))) AS app FROM imported_stores
          WHERE ${LIVE(country, tag)} AND apps IS NOT NULL AND apps <> ''
        ) x WHERE app <> '' GROUP BY app ORDER BY n DESC`;

  return {
    date: new Date().toISOString().slice(0, 10),
    storesTotal,
    newThisWeek: Number(t.new_week),
    discoveredByPeriod: {
      day: Number(t.disc_day), week: Number(t.disc_week), month: Number(t.disc_month),
      quarter: Number(t.disc_quarter), year: Number(t.disc_year),
    },
    plusTotal: Number(t.plus_total),
    plusNewThisWeek: Number(t.plus_new_week),
    paymentsVerifiedStores: verified,
    paymentsByProvider: items(toSorted(providerCount), verified),
    paymentsByType,
    firstProvider: items(toSorted(firstCount), verified),
    themes: items(themes, themesKnown),
    themesKnown,
    categories: items(categories, categoriesKnown),
    categoriesKnown,
    cities: items(cities, citiesKnown),
    citiesKnown,
    apps: items(apps.map((a) => ({ label: prettyApp(a.label), n: a.n })), appsKnown),
    appsKnown,
    shippingByProvider: items([...shipCount.entries()].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n), shippingKnown),
    shippingKnown,
    freeShippingStores: Number(t.free_shipping_stores),
    churn: {
      total: Number(t.churn_total),
      checked: Number(t.churn_checked),
      active: Number(t.churn_active),
      migrated: Number(t.churn_migrated),
      dead: Number(t.churn_dead),
      survival: Number(t.churn_checked) ? pct(Number(t.churn_active), Number(t.churn_checked)) : null,
    },
  };
}

/** Homepage headline numbers, computed from the SAME live universe as /insights
 *  (Postgres imported_stores) so the two public pages never disagree. Replaces
 *  the old Google-Sheet feed, which only saw ~200-700 discovery-engine stores. */
// Dashboard tile stats — one aggregate query, identical for every viewer of a
// market and slow-moving, so cache per-country with a short TTL (with an in-flight
// guard). Keeps the tiles from timing out when the enrichment jobs load the DB.
type CachedStats = { at: number; data: import("./sheets").FeedStats };
const STATS_TTL_MS = 5 * 60 * 1000;
const _statsCache = new Map<string, CachedStats>();
const _statsInflight = new Map<string, Promise<import("./sheets").FeedStats>>();

export async function getHomeStats(country = "ZA"): Promise<import("./sheets").FeedStats> {
  const hit = _statsCache.get(country);
  if (hit && Date.now() - hit.at < STATS_TTL_MS) return hit.data;
  let inflight = _statsInflight.get(country);
  if (!inflight) {
    inflight = getHomeStatsUncached(country)
      .then((data) => { _statsCache.set(country, { at: Date.now(), data }); _statsInflight.delete(country); return data; })
      .catch((e) => { _statsInflight.delete(country); if (hit) return hit.data; throw e; });
    _statsInflight.set(country, inflight);
  }
  return inflight;
}

async function getHomeStatsUncached(country = "ZA"): Promise<import("./sheets").FeedStats> {
  const sql = db();
  // Restrict to the country's live rows in the WHERE (uses the published/country
  // indexes and scans only those rows' needed columns) — NOT a `SELECT *` subquery
  // over the whole table, which under write-load went pathological (a single run
  // once hogged the DB for 23 min). Same numbers, a fraction of the work.
  const [t] = await sql`
    SELECT
      COUNT(*)::int                                                                       AS stores,
      COUNT(*) FILTER (WHERE discovered_at IS NOT NULL AND discovered_at >= CURRENT_DATE - 7)::int AS new_week,
      COUNT(*) FILTER (WHERE email IS NOT NULL AND email <> '')::int                       AS with_email,
      COUNT(*) FILTER (WHERE plus)::int                                                    AS plus
    FROM imported_stores
    WHERE published AND country = ${country}
      AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))`;
  // Freshness = the discovery pipeline's last run (updates every pipeline pass),
  // not the imported first_seen dates (historical) or created_at (frozen at import).
  const [f] = await sql`SELECT MAX(enriched_at)::date AS d FROM store_fingerprints`;

  const stores = Number(t.stores);
  return {
    storesTracked: stores,
    southAfrica: stores, // the tracked universe is South Africa
    newThisWeek: Number(t.new_week),
    withEmailPct: pct(Number(t.with_email), stores),
    withEmail: Number(t.with_email),
    plusFlagged: Number(t.plus),
    updatedAt: (f?.d as string) || null,
    live: stores > 0,
  };
}

/** The weekly digest's market-pulse block, computed from Postgres (same universe
 *  as /insights) and shaped as the legacy InsightSnapshot the digest expects.
 *  Replaces the old Sheet-backed fetchInsights() so the email agrees with the app. */
export async function digestSnapshot(): Promise<import("./sheets").InsightSnapshot> {
  const d = await computeInsights();
  return {
    date: d.date,
    stores_total: d.storesTotal,
    new_this_week: d.newThisWeek,
    plus_total: d.plusTotal,
    plus_new_this_week: d.plusNewThisWeek,
    payments_verified_stores: d.paymentsVerifiedStores,
    payments_by_provider: d.paymentsByProvider,
    payments_by_type: Object.fromEntries(
      Object.entries(d.paymentsByType).map(([k, v]) => [k, v.count]),
    ),
    first_at_checkout: d.firstProvider,
    themes: d.themes,
    apps: d.apps,
  };
}

/** Persist today's snapshot (idempotent per day) — call from the daily cron. */
export async function snapshotInsights(data: InsightsData): Promise<void> {
  await db()`
    INSERT INTO insights_snapshots (date, data) VALUES (${data.date}, ${db().json(data)})
    ON CONFLICT (date) DO UPDATE SET data = EXCLUDED.data, created_at = now()`;
}

/** Past daily snapshots (oldest→newest) for the over-time trends. */
export async function insightsHistory(limit = 400): Promise<InsightsData[]> {
  const rows = await db()`
    SELECT data FROM insights_snapshots ORDER BY date DESC LIMIT ${limit}`;
  return rows.map((r) => r.data as InsightsData).reverse();
}

/** The date from which trends & forward-churn are measured (null = since first
 *  snapshot). Reset after a bulk import so the batch doesn't skew the trends. */
export async function getBaselineDate(): Promise<string | null> {
  try {
    const rows = await db()`SELECT value FROM app_settings WHERE key = 'insights_baseline_date'`;
    return rows.length ? (rows[0].value as string) : null;
  } catch {
    return null; // table not yet created
  }
}

export async function setBaselineDate(date: string): Promise<void> {
  await db()`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES ('insights_baseline_date', ${date}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

/* -------------------------------------------------- standalone section reports --- */

export type PeriodKey = "day" | "week" | "month" | "quarter" | "year";
const REPORT_PERIOD_DAYS: Record<PeriodKey, number> = { day: 1, week: 7, month: 30, quarter: 91, year: 365 };
export type ReportItem = { label: string; total: number; period: number };
export type SectionReport = {
  section: string; title: string; drillParam: string; period: PeriodKey; periodDays: number;
  items: ReportItem[]; allTimeStores: number; periodStores: number;
};

// Apps are apps.shopify.com/<slug> URLs — show a clean name, drop custom/store links.
function appSlugLabel(raw: string): string | null {
  const slug = raw.toLowerCase().match(/apps\.shopify\.com\/([a-z0-9][a-z0-9-]*)/)?.[1];
  if (!slug || ["partners", "collections", "browse", "categories", "stores"].includes(slug)) return null;
  return slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// One config per report. `multi` = semicolon-list column. `listNorm` processes the whole
// token list (payments — folds card-icons/sub-rails then canonicalises); `norm` maps one
// token (null = drop). Single-value columns are taken as-is.
type SecCfg = {
  column: string; multi: boolean; title: string; drillParam: string;
  norm?: (s: string) => string | null; listNorm?: (arr: string[]) => string[];
  firstOnly?: boolean; // count only the FIRST value per store (e.g. leading gateway)
};
const REPORT_SECTIONS: Record<string, SecCfg> = {
  payments:   { column: "payments", multi: true, title: "Payment providers", drillParam: "payment", listNorm: (arr) => cleanPayments(arr).map(canonicalProvider) },
  leading:    { column: "payments", multi: true, title: "Leading provider at checkout", drillParam: "payment", listNorm: (arr) => cleanPayments(arr).map(canonicalProvider), firstOnly: true },
  shipping:   { column: "shipping_providers", multi: true, title: "Shipping providers", drillParam: "shipping", norm: normalizeCarrier },
  apps:       { column: "apps", multi: true, title: "Apps installed", drillParam: "app", norm: appSlugLabel },
  categories: { column: "category", multi: false, title: "Categories", drillParam: "category" },
  themes:     { column: "theme", multi: false, title: "Themes", drillParam: "theme" },
  cities:     { column: "city", multi: false, title: "Cities", drillParam: "city" },
};
export const REPORT_SECTION_KEYS = Object.keys(REPORT_SECTIONS);
export function isReportSection(s: string): boolean { return s in REPORT_SECTIONS; }

/** A standalone, time-filtered report for one insights dimension. Each item shows its
 *  ALL-TIME store count plus GENUINE ADOPTIONS in the chosen period: stores DISCOVERED
 *  in the period with that value, plus (payments only) switches TO it minus switches
 *  AWAY (from the change log). Backfilling old stores' data never moves the period
 *  number — so the period reflects the filter, not our vetting catching up. */
export async function sectionReport(section: string, country = "ZA", period: PeriodKey = "week"): Promise<SectionReport> {
  const cfg = REPORT_SECTIONS[section];
  if (!cfg) throw new Error(`unknown report section: ${section}`);
  const P = REPORT_PERIOD_DAYS[period] ?? 7;
  const sql = db();
  const AND_C = country ? sql`AND UPPER(country) = ${country.toUpperCase()}` : sql``;
  const rows = await sql<{ val: string; discovered_at: Date | null }[]>`
    SELECT ${sql(cfg.column)} AS val, discovered_at FROM imported_stores
    WHERE published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
      AND ${sql(cfg.column)} IS NOT NULL AND ${sql(cfg.column)} <> '' ${AND_C}`;

  const cut = Date.now() - P * 864e5;
  const total = new Map<string, number>(), periodM = new Map<string, number>();
  let allTimeStores = 0, periodStores = 0;
  for (const r of rows) {
    const raw = cfg.multi ? String(r.val).split(";").map((x) => x.trim()).filter(Boolean) : [String(r.val).trim()];
    let vals = [...new Set(
      (cfg.listNorm ? cfg.listNorm(raw) : cfg.norm ? raw.map(cfg.norm) : raw).filter(Boolean) as string[],
    )];
    if (cfg.firstOnly) vals = vals.slice(0, 1); // just the primary/leading value
    if (!vals.length) continue;
    allTimeStores++;
    const isNew = r.discovered_at != null && new Date(r.discovered_at).getTime() >= cut;
    if (isNew) periodStores++;
    for (const v of vals) {
      total.set(v, (total.get(v) ?? 0) + 1);
      if (isNew) periodM.set(v, (periodM.get(v) ?? 0) + 1);
    }
  }

  // Payments: fold in genuine SWITCHES from the change log (adds to the destination
  // PSP, subtracts from the dropped one) — real movement, not first-time vetting.
  if (section === "payments") {
    const changes = await sql<{ added: string[] | null; removed: string[] | null }[]>`
      SELECT pc.added, pc.removed FROM payment_changes pc
      JOIN imported_stores i ON i.domain = pc.domain
      WHERE pc.changed_at >= now() - (${P}::int * interval '1 day')
        ${country ? sql`AND UPPER(i.country) = ${country.toUpperCase()}` : sql``}`.catch(() => []);
    for (const c of changes) {
      for (const a of c.added ?? []) { const v = canonicalProvider(a); if (v) periodM.set(v, (periodM.get(v) ?? 0) + 1); }
      for (const rm of c.removed ?? []) { const v = canonicalProvider(rm); if (v) periodM.set(v, (periodM.get(v) ?? 0) - 1); }
    }
  }

  const items = [...total.entries()]
    .map(([label, t]) => ({ label, total: t, period: periodM.get(label) ?? 0 }))
    .sort((a, b) => b.total - a.total);
  return { section, title: cfg.title, drillParam: cfg.drillParam, period, periodDays: P, items, allTimeStores, periodStores };
}
