import postgres from "postgres";

// Animated "African eCommerce" replay data. Distinct from africaOverview() (a single latest-frame
// rollup): this returns a MONTHLY time series + a sampled set of real store events so the map, the
// ranked panel and the growth chart can replay ~2015→now off one shared timeline.
//
// Truthfulness rules baked in here:
//  - The clock is `launched_at` — a genuine store-birth estimate (WordPress oldest post, earliest
//    product, SSL cert, vendor created-date), NOT our discovery time (verified: launched_at almost
//    never equals discovered_at). So the replay shows stores being born, not us finding them.
//  - Floor at 2015-01: the importer only trusts launch dates ≥2015; older rows are sparse/garbage.
//  - We ship AGGREGATES + a small SAMPLED event set, never the ~72k store rows.
//  - The chart counts "tracked stores", not "the market": a live-only snapshot is survivorship-
//    biased (dead older stores leave), so recent months read denser. The UI says "tracked", once.
//  - `ops` is REAL recent scan/discovery activity — the numbers and the domains in the feed are
//    live counts, so the "constantly scanning" story is honest, not staged.

let _sql: ReturnType<typeof postgres> | null = null;
function db() {
  if (!_sql) _sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 3, idle_timeout: 20 });
  return _sql;
}

// 55 African ISO2 codes (same set the overview map uses).
const AFRICA_ISO2 = [
  "DZ", "AO", "BJ", "BW", "BF", "BI", "CM", "CV", "CF", "TD", "KM", "CG", "CD", "CI", "DJ", "EG",
  "GQ", "ER", "SZ", "ET", "GA", "GM", "GH", "GN", "GW", "KE", "LS", "LR", "LY", "MG", "MW", "ML",
  "MR", "MU", "MA", "MZ", "NA", "NE", "NG", "RW", "ST", "SN", "SC", "SL", "SO", "ZA", "SS", "SD",
  "TZ", "TG", "TN", "UG", "EH", "ZM", "ZW",
];

const FLOOR = "2015-01-01";
function h32(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

// Platform groups. "shopify" folds in not-yet-classified CT discoveries (platform NULL), matching
// platformClause() elsewhere; "woo" = confirmed WooCommerce; "rest" = Magento/other (only affects
// the "All" view). Client filters map: All = shopify+woo+rest, Shopify = shopify, WooCommerce = woo.
export type PlatGroup = "shopify" | "woo" | "rest";
const GROUP_SQL = (sql: ReturnType<typeof postgres>) => sql`
  CASE WHEN lower(platform) = 'woocommerce' THEN 'woo'
       WHEN lower(platform) = 'shopify' OR platform IS NULL THEN 'shopify'
       ELSE 'rest' END`;

// A richer sampled store, shown as a spotlight card as its pulse lands. domain drives the favicon;
// theme is real when we have it. Payment/shipping are filled in the client (plausible, per-country).
export type FeaturedStore = { i: number; c: string; g: PlatGroup; domain: string; name: string; theme: string | null };
export type OpsFeed = {
  scanned24h: number; disc7d: number; discToday: number;
  recent: { domain: string; c: string; platform: string }[];
};

export type AfricaTimeline = {
  months: string[];                                  // YYYY-MM buckets, oldest→newest
  /** per-country monthly launch counts, by platform group. countries[iso2][group] is length === months. */
  countries: Record<string, Record<PlatGroup, number[]>>;
  /** lean ambient map pulses: [monthIndex, iso2, group] */
  pulses: [number, string, PlatGroup][];
  /** spotlight stores (subset of the pulses) with name/domain/theme for the info card */
  featured: FeaturedStore[];
  ops: OpsFeed;
  meta: {
    lastLaunch: string | null;                       // most recent launch date in the set
    lastRefresh: string | null;                      // when the underlying rows were last re-checked
    totalTracked: number;                            // live African stores with a usable launch date
    withoutDate: number;                             // live African stores excluded (no launch date)
  };
};

function monthRange(from: string, toExclusive: Date): string[] {
  const out: string[] = [];
  const d = new Date(from + "T00:00:00Z");
  while (d < toExclusive) {
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

export async function africaTimeline(): Promise<AfricaTimeline> {
  const sql = db();
  const base = sql`published AND UPPER(country) = ANY(${AFRICA_ISO2})
    AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))`;

  // First bucket = FLOOR; last bucket = the current month (inclusive). Everything is clamped into
  // this window so a stray future/garbage date can't stretch the axis.
  const nextMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1));
  const months = monthRange(FLOOR, nextMonth);
  const idx = new Map(months.map((m, i) => [m, i]));

  // Monthly launch counts per (country, group).
  const rows = await sql<{ c: string; g: PlatGroup; m: string; n: number }[]>`
    SELECT UPPER(country) AS c, ${GROUP_SQL(sql)} AS g,
           to_char(date_trunc('month', launched_at), 'YYYY-MM') AS m, COUNT(*)::int AS n
    FROM imported_stores
    WHERE ${base} AND launched_at >= ${FLOOR} AND launched_at < ${nextMonth}
    GROUP BY 1, 2, 3`;

  const countries: AfricaTimeline["countries"] = {};
  const blank = (): Record<PlatGroup, number[]> => ({
    shopify: new Array(months.length).fill(0),
    woo: new Array(months.length).fill(0),
    rest: new Array(months.length).fill(0),
  });
  for (const r of rows) {
    const i = idx.get(r.m);
    if (i == null) continue;
    (countries[r.c] ??= blank())[r.g][i] += Number(r.n);
  }

  // Sampled real events — up to 8 per (country, group, month), deterministic by domain hash.
  type EvRow = { c: string; g: PlatGroup; m: string; domain: string; name: string | null; theme: string | null };
  const ev = await sql<EvRow[]>`
    WITH e AS (
      SELECT UPPER(country) AS c, ${GROUP_SQL(sql)} AS g,
             to_char(date_trunc('month', launched_at), 'YYYY-MM') AS m,
             domain, NULLIF(name, '') AS name, NULLIF(theme, '') AS theme,
             row_number() OVER (PARTITION BY UPPER(country), ${GROUP_SQL(sql)},
               date_trunc('month', launched_at) ORDER BY md5(domain)) AS rn
      FROM imported_stores
      WHERE ${base} AND launched_at >= ${FLOOR} AND launched_at < ${nextMonth}
    )
    SELECT c, g, m, domain, name, theme FROM e WHERE rn <= 8`;

  // Group candidates by month, then by country, so we can spread the sample ACROSS the continent
  // instead of letting South Africa (which has the most stores) dominate the dots and spotlights.
  const byMonth = new Map<number, EvRow[]>();
  for (const e of ev) {
    const i = idx.get(e.m);
    if (i == null) continue;
    (byMonth.get(i) ?? byMonth.set(i, []).get(i)!).push(e);
  }
  const bestFirst = (a: EvRow, b: EvRow) =>
    (Number(!!b.name && b.name !== b.domain) - Number(!!a.name && a.name !== a.domain)) || (Number(!!b.theme) - Number(!!a.theme));
  const pulses: AfricaTimeline["pulses"] = [];
  const featured: FeaturedStore[] = [];
  for (const [i, list] of [...byMonth.entries()].sort((a, b) => a[0] - b[0])) {
    const byCountry = new Map<string, EvRow[]>();
    for (const e of list) (byCountry.get(e.c) ?? byCountry.set(e.c, []).get(e.c)!).push(e);
    // Rotate country order per month (deterministic) so the same few markets aren't always first.
    const order = [...byCountry.keys()].sort((a, b) => h32(a + i) - h32(b + i));
    // Ambient dots: up to 3 per country per month → the whole map twinkles, not just ZA.
    for (const c of order) {
      const es = byCountry.get(c)!; const keep = Math.min(es.length, 3); const step = es.length / keep;
      for (let k = 0; k < keep; k++) { const e = es[Math.floor(k * step)]; pulses.push([i, e.c, e.g]); }
    }
    // Spotlights: round-robin one-per-country (best name/theme first), up to 6 markets each month.
    for (const c of order.slice(0, 6)) {
      const e = [...byCountry.get(c)!].sort(bestFirst)[0];
      featured.push({ i, c: e.c, g: e.g, domain: e.domain, name: e.name || e.domain, theme: e.theme });
    }
  }
  const BUDGET = 2600;
  let sampled = pulses;
  if (pulses.length > BUDGET) { const st = pulses.length / BUDGET; sampled = Array.from({ length: BUDGET }, (_, k) => pulses[Math.floor(k * st)]); }

  const [meta] = await sql<{ last_launch: string | null; last_refresh: string | null; total: number; without: number }[]>`
    SELECT to_char(max(launched_at), 'YYYY-MM-DD') AS last_launch,
           to_char(max(GREATEST(live_checked_at, catalog_checked_at, payments_checked_at)), 'YYYY-MM-DD') AS last_refresh,
           COUNT(*) FILTER (WHERE launched_at IS NOT NULL AND launched_at >= ${FLOOR})::int AS total,
           COUNT(*) FILTER (WHERE launched_at IS NULL OR launched_at < ${FLOOR})::int AS without
    FROM imported_stores WHERE ${base}`;

  // Real ops activity — live counts + the most recently re-scanned stores (feeds the "always on" box).
  const [opsCounts] = await sql<{ scanned24h: number; disc7d: number; disc_today: number }[]>`
    SELECT COUNT(*) FILTER (WHERE GREATEST(payments_checked_at, live_checked_at, catalog_checked_at) >= now() - interval '24 hours')::int AS scanned24h,
           COUNT(*) FILTER (WHERE discovered_at >= current_date - 7)::int AS disc7d,
           COUNT(*) FILTER (WHERE discovered_at = current_date)::int AS disc_today
    FROM imported_stores WHERE ${base}`;
  const recent = await sql<{ domain: string; c: string; platform: string }[]>`
    SELECT domain, UPPER(country) AS c, COALESCE(NULLIF(platform, ''), 'Shopify') AS platform
    FROM imported_stores
    WHERE ${base} AND GREATEST(payments_checked_at, live_checked_at, catalog_checked_at) IS NOT NULL
    ORDER BY GREATEST(payments_checked_at, live_checked_at, catalog_checked_at) DESC LIMIT 24`;

  return {
    months, countries, pulses: sampled, featured,
    ops: {
      scanned24h: Number(opsCounts?.scanned24h ?? 0),
      disc7d: Number(opsCounts?.disc7d ?? 0),
      discToday: Number(opsCounts?.disc_today ?? 0),
      recent,
    },
    meta: {
      lastLaunch: meta?.last_launch ?? null,
      lastRefresh: meta?.last_refresh ?? null,
      totalTracked: Number(meta?.total ?? 0),
      withoutDate: Number(meta?.without ?? 0),
    },
  };
}
