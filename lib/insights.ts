/** Market Insights, computed live from the Postgres store universe
 *  (imported_stores) — NOT the old shopify-radar Sheet snapshot (which only
 *  counted ~700 discovery-engine stores). This unifies /insights with the rest
 *  of the app and gives absolute counts + every provider/theme/app/category, so
 *  the UI can drill in. Daily snapshots (insights_snapshots) power the trends.
 */

import postgres from "postgres";
import { classify, cleanPayments, PAY_TYPES, type PayType } from "./payments-taxonomy";

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
  apps: InsightItem[];
  appsKnown: number;
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

// Published live SA stores — the market universe the insights describe.
const LIVE = () =>
  db()`published AND country = 'ZA' AND (live_status IS NULL OR live_status NOT IN ('dead', 'migrated'))`;

export async function computeInsights(): Promise<InsightsData> {
  const sql = db();

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
      COUNT(*) FILTER (WHERE live AND apps IS NOT NULL AND apps <> '')::int        AS apps_known
    FROM (
      SELECT *,
        (published AND country = 'ZA' AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))) AS live,
        (published AND country = 'ZA') AS za,
        -- "new this week" = added to Terrain in the last 7 days (created_at).
        -- NOT first_seen: that's the store's historical launch date (2006-2023),
        -- so it would always read 0. Matches getHomeStats so the pages agree.
        (created_at >= now() - interval '7 days') AS fresh
      FROM imported_stores
    ) s`;

  const storesTotal = Number(t.stores_total);
  const themesKnown = Number(t.themes_known);
  const categoriesKnown = Number(t.categories_known);
  const appsKnown = Number(t.apps_known);

  // Per-store payments → provider share, type share (stores offering ≥1), and
  // first-listed provider (best-effort ordering from the checkout sync).
  const payRows = await sql`
    SELECT payments FROM imported_stores
    WHERE ${LIVE()} AND payments IS NOT NULL AND payments <> ''`;
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

  type Agg = { label: string; n: number };
  const [themes, categories, apps] = await Promise.all([
    sql<Agg[]>`SELECT theme AS label, COUNT(*)::int n FROM imported_stores
        WHERE ${LIVE()} AND theme IS NOT NULL AND theme <> '' GROUP BY theme ORDER BY n DESC`,
    sql<Agg[]>`SELECT category AS label, COUNT(*)::int n FROM imported_stores
        WHERE ${LIVE()} AND category IS NOT NULL GROUP BY category ORDER BY n DESC`,
    sql<Agg[]>`SELECT app AS label, COUNT(*)::int n FROM (
          SELECT trim(unnest(string_to_array(apps, ';'))) AS app FROM imported_stores
          WHERE ${LIVE()} AND apps IS NOT NULL AND apps <> ''
        ) x WHERE app <> '' GROUP BY app ORDER BY n DESC`,
  ]);

  return {
    date: new Date().toISOString().slice(0, 10),
    storesTotal,
    newThisWeek: Number(t.new_week),
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
    apps: items(apps.map((a) => ({ label: prettyApp(a.label), n: a.n })), appsKnown),
    appsKnown,
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
export async function getHomeStats(): Promise<import("./sheets").FeedStats> {
  const sql = db();
  const [t] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE live)::int                                        AS stores,
      COUNT(*) FILTER (WHERE live AND created_at >= now() - interval '7 days')::int AS new_week,
      COUNT(*) FILTER (WHERE live AND email IS NOT NULL AND email <> '')::int  AS with_email,
      COUNT(*) FILTER (WHERE live AND plus)::int                              AS plus
    FROM (
      SELECT *,
        (published AND country = 'ZA' AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))) AS live
      FROM imported_stores
    ) s`;
  // Freshness = the discovery pipeline's last run (updates every pipeline pass),
  // not the imported first_seen dates (historical) or created_at (frozen at import).
  const [f] = await sql`SELECT MAX(enriched_at)::date AS d FROM store_fingerprints`;

  const stores = Number(t.stores);
  return {
    storesTracked: stores,
    southAfrica: stores, // the tracked universe is South Africa
    newThisWeek: Number(t.new_week),
    withEmailPct: pct(Number(t.with_email), stores),
    plusFlagged: Number(t.plus),
    updatedAt: (f?.d as string) || null,
    live: stores > 0,
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
