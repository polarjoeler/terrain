import postgres from "postgres";
import { JP_REGIONS, type JpRegion } from "./japan-regions";
export { JP_REGIONS, type JpRegion };

// Animated "Japanese eCommerce" replay — the Japan counterpart to africaTimeline(), but grouped by
// REGION (地方) instead of country. Big honesty caveat baked in and surfaced in the UI:
//   Japan store location is almost entirely missing in our data (region ~1.5%, city ~10%, and the
//   city values are Tokyo-wards-heavy). So we can only LOCATE ~10% of stores. From that located
//   sample we derive each region's share, then PROJECT the remaining ~90% across regions by those
//   weights (deterministically by domain hash). The regional split is therefore an ESTIMATE — the
//   page says so. Totals, launch dates and CMS are real; only the region a store sits in is inferred
//   for the unlocated majority. This all collapses to real data the moment location lands on import.

let _sql: ReturnType<typeof postgres> | null = null;
function db() {
  if (!_sql) _sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 3, idle_timeout: 20 });
  return _sql;
}

const FLOOR = "2015-01-01";
function h32(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

// Locate a store from its region/city string → region, or null if we can't (→ projected). Only
// UNAMBIGUOUS signals map; shared ward names (中央区/北区/西区…) are intentionally left unlocated so
// we don't fabricate precision. Keyword → region.
const LOC: [JpRegion, string[]][] = [
  ["Hokkaido", ["北海道", "札幌", "Sapporo", "Hokkaido"]],
  ["Tohoku", ["宮城", "仙台", "Sendai", "青森", "Aomori", "岩手", "Iwate", "秋田", "Akita", "山形", "Yamagata", "福島", "Fukushima"]],
  ["Kanto", ["東京", "Tokyo", "渋谷", "Shibuya", "新宿", "Shinjuku", "千代田", "Chiyoda", "世田谷", "Setagaya", "台東", "Taito", "品川", "Shinagawa", "目黒", "Meguro", "杉並", "Suginami", "豊島", "Toshima", "文京", "Bunkyo", "練馬", "Nerima", "足立", "Adachi", "葛飾", "Katsushika", "江戸川", "Edogawa", "墨田", "Sumida", "江東", "Koto", "荒川", "Arakawa", "板橋", "Itabashi", "Jingumae", "Harajuku", "Roppongi", "Ginza", "Akihabara", "Ikebukuro", "港区", "Minato-ku", "神奈川", "Kanagawa", "横浜", "Yokohama", "川崎", "Kawasaki", "埼玉", "Saitama", "千葉", "Chiba", "茨城", "Ibaraki", "栃木", "Tochigi", "群馬", "Gunma"]],
  ["Chubu", ["愛知", "Aichi", "名古屋", "Nagoya", "静岡", "Shizuoka", "新潟", "Niigata", "長野", "Nagano", "岐阜", "Gifu", "石川", "金沢", "Kanazawa", "富山", "Toyama", "福井", "Fukui", "山梨", "Yamanashi"]],
  ["Kansai", ["大阪", "Osaka", "天王寺", "Tennoji", "難波", "Namba", "梅田", "Umeda", "京都", "Kyoto", "神戸", "Kobe", "兵庫", "Hyogo", "奈良", "Nara", "滋賀", "Shiga", "和歌山", "Wakayama", "三重", "Mie"]],
  ["Chugoku", ["広島", "Hiroshima", "岡山", "Okayama", "山口", "Yamaguchi", "島根", "Shimane", "鳥取", "Tottori"]],
  ["Shikoku", ["香川", "高松", "Takamatsu", "愛媛", "松山", "Matsuyama", "徳島", "Tokushima", "高知", "Kochi"]],
  ["Kyushu", ["福岡", "Fukuoka", "博多", "Hakata", "熊本", "Kumamoto", "鹿児島", "Kagoshima", "長崎", "Nagasaki", "大分", "Oita", "宮崎", "Miyazaki", "佐賀", "Saga", "沖縄", "Okinawa", "那覇", "Naha"]],
];
function locate(loc: string | null): JpRegion | null {
  if (!loc) return null;
  for (const [region, keys] of LOC) for (const k of keys) if (loc.includes(k)) return region;
  return null;
}

export type PlatGroup = "shopify" | "woo" | "rest";
const GROUP_SQL = (sql: ReturnType<typeof postgres>) => sql`
  CASE WHEN lower(platform) = 'woocommerce' THEN 'woo'
       WHEN lower(platform) = 'shopify' OR platform IS NULL THEN 'shopify'
       ELSE 'rest' END`;

export type FeaturedStore = { i: number; r: JpRegion; g: PlatGroup; domain: string; name: string; theme: string | null };
export type OpsFeed = { scanned24h: number; disc7d: number; discToday: number; recent: { domain: string; c: string; platform: string }[] };
export type JapanTimeline = {
  months: string[];
  regions: Record<JpRegion, Record<PlatGroup, number[]>>;
  pulses: [number, JpRegion, PlatGroup][];
  featured: FeaturedStore[];
  ops: OpsFeed;
  meta: { lastLaunch: string | null; lastRefresh: string | null; totalTracked: number; located: number };
};

function monthRange(from: string, toExclusive: Date): string[] {
  const out: string[] = []; const d = new Date(from + "T00:00:00Z");
  while (d < toExclusive) { out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`); d.setUTCMonth(d.getUTCMonth() + 1); }
  return out;
}

export async function japanTimeline(): Promise<JapanTimeline> {
  const sql = db();
  const base = sql`published AND country = 'JP' AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))`;
  const nextMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1));
  const months = monthRange(FLOOR, nextMonth);
  const idx = new Map(months.map((m, i) => [m, i]));

  // Pull every launched JP store (minimal fields). ~29k rows — fine for a 30-min cached compute.
  type Row = { domain: string; m: string; g: PlatGroup; loc: string | null; name: string | null; theme: string | null };
  const rows = await sql<Row[]>`
    SELECT domain, to_char(date_trunc('month', launched_at), 'YYYY-MM') AS m, ${GROUP_SQL(sql)} AS g,
           COALESCE(NULLIF(region, ''), NULLIF(city, '')) AS loc, NULLIF(name, '') AS name, NULLIF(theme, '') AS theme
    FROM imported_stores
    WHERE ${base} AND launched_at >= ${FLOOR} AND launched_at < ${nextMonth}`;

  // Pass 1: locate what we can, tally located-region weights.
  const located = new Map<string, JpRegion>();
  const wCount: Record<string, number> = {};
  let locatedN = 0;
  for (const r of rows) {
    const reg = locate(r.loc);
    if (reg) { located.set(r.domain, reg); wCount[reg] = (wCount[reg] ?? 0) + 1; locatedN++; }
  }
  // Region weights from the located sample → cumulative distribution for projecting the rest.
  const totalW = Math.max(1, locatedN);
  const cum: { r: JpRegion; upto: number }[] = []; let acc = 0;
  for (const r of JP_REGIONS) { acc += (wCount[r] ?? 0) / totalW; cum.push({ r, upto: acc }); }
  const project = (domain: string): JpRegion => {
    const x = h32(domain + "jp") / 4294967296;
    for (const c of cum) if (x <= c.upto) return c.r;
    return "Kanto"; // fallback (Kanto is always the heaviest)
  };
  const regionOf = (r: Row): JpRegion => located.get(r.domain) ?? project(r.domain);

  // Pass 2: monthly counts per (region, group).
  const regions = Object.fromEntries(JP_REGIONS.map((r) => [r, { shopify: new Array(months.length).fill(0), woo: new Array(months.length).fill(0), rest: new Array(months.length).fill(0) }])) as JapanTimeline["regions"];
  for (const r of rows) { const i = idx.get(r.m); if (i == null) continue; regions[regionOf(r)][r.g][i]++; }

  // Pulses + featured, spread across regions (round-robin), like the Africa build.
  const byMonth = new Map<number, Row[]>();
  for (const r of rows) { const i = idx.get(r.m); if (i == null) continue; (byMonth.get(i) ?? byMonth.set(i, []).get(i)!).push(r); }
  const bestFirst = (a: Row, b: Row) =>
    (Number(!!b.name && b.name !== b.domain) - Number(!!a.name && a.name !== a.domain)) || (Number(!!b.theme) - Number(!!a.theme));
  const pulses: JapanTimeline["pulses"] = []; const featured: FeaturedStore[] = [];
  for (const [i, list] of [...byMonth.entries()].sort((a, b) => a[0] - b[0])) {
    const byRegion = new Map<JpRegion, Row[]>();
    for (const r of list) { const reg = regionOf(r); (byRegion.get(reg) ?? byRegion.set(reg, []).get(reg)!).push(r); }
    const order = [...byRegion.keys()].sort((a, b) => h32(a + i) - h32(b + i));
    for (const reg of order) {
      const es = byRegion.get(reg)!; const keep = Math.min(es.length, 3); const step = es.length / keep;
      for (let k = 0; k < keep; k++) pulses.push([i, reg, es[Math.floor(k * step)].g]);
    }
    for (const reg of order.slice(0, 6)) {
      const e = [...byRegion.get(reg)!].sort(bestFirst)[0];
      featured.push({ i, r: reg, g: e.g, domain: e.domain, name: e.name || e.domain, theme: e.theme });
    }
  }
  const BUDGET = 2600; let sampled = pulses;
  if (pulses.length > BUDGET) { const st = pulses.length / BUDGET; sampled = Array.from({ length: BUDGET }, (_, k) => pulses[Math.floor(k * st)]); }

  const [meta] = await sql<{ last_launch: string | null; last_refresh: string | null; total: number }[]>`
    SELECT to_char(max(launched_at), 'YYYY-MM-DD') AS last_launch,
           to_char(max(GREATEST(live_checked_at, catalog_checked_at, payments_checked_at)), 'YYYY-MM-DD') AS last_refresh,
           COUNT(*) FILTER (WHERE launched_at IS NOT NULL AND launched_at >= ${FLOOR})::int AS total
    FROM imported_stores WHERE ${base}`;
  const [opsCounts] = await sql<{ scanned24h: number; disc7d: number; disc_today: number }[]>`
    SELECT COUNT(*) FILTER (WHERE GREATEST(payments_checked_at, live_checked_at, catalog_checked_at) >= now() - interval '24 hours')::int AS scanned24h,
           COUNT(*) FILTER (WHERE discovered_at >= current_date - 7)::int AS disc7d,
           COUNT(*) FILTER (WHERE discovered_at = current_date)::int AS disc_today
    FROM imported_stores WHERE ${base}`;
  const recent = await sql<{ domain: string; c: string; platform: string }[]>`
    SELECT domain, 'JP' AS c, COALESCE(NULLIF(platform, ''), 'Shopify') AS platform FROM imported_stores
    WHERE ${base} AND GREATEST(payments_checked_at, live_checked_at, catalog_checked_at) IS NOT NULL
    ORDER BY GREATEST(payments_checked_at, live_checked_at, catalog_checked_at) DESC LIMIT 24`;

  return {
    months, regions, pulses: sampled, featured,
    ops: { scanned24h: Number(opsCounts?.scanned24h ?? 0), disc7d: Number(opsCounts?.disc7d ?? 0), discToday: Number(opsCounts?.disc_today ?? 0), recent },
    meta: { lastLaunch: meta?.last_launch ?? null, lastRefresh: meta?.last_refresh ?? null, totalTracked: Number(meta?.total ?? 0), located: locatedN },
  };
}
