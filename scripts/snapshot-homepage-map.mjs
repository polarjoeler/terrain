/** Refresh the committed homepage interactive-map snapshots. The homepage LiveMap renders entirely
 *  from these committed files (zero per-request DB work), so run this occasionally to keep them current:
 *
 *    node --env-file=.env.local scripts/snapshot-homepage-map.mjs
 *
 *  Writes three files under lib/:
 *    world-points-snapshot.json   — top countries by live store count   → globe pin density + country totals
 *    world-stores-snapshot.json   — a sample of real stores per country → the pop-up store tiles
 *    geo-timeline-snapshot.json   — per-country monthly launches by CMS + per-city monthly (focus markets)
 *                                   → the scoped, ticking leaderboard + the synced growth chart
 *
 *  All read-only; none touch the heavy agg_cache. The queries mirror the originals used to seed the files.
 */
import postgres from "postgres";
import { writeFileSync, statSync } from "node:fs";

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 2, connect_timeout: 15 });
const LIVE = sql`(live_status IS NULL OR live_status NOT IN ('dead','migrated'))`;
const ALIAS = { UK: "GB", EL: "GR" };                       // our country codes → ISO-2 used in the world map
const alias = (c) => ALIAS[c] ?? c;
const grp = (p) => { p = (p || "").toLowerCase(); return p === "woocommerce" ? "woo" : (p === "" || p === "shopify" ? "shopify" : "rest"); };
const sizeKB = (f) => (statSync(f).size / 1024).toFixed(0) + "KB";

// City names are messy in non-ZA markets (sub-localities, Arabic/English dupes, case). Collapse known
// neighbourhoods into their city, drop stray non-English entries, title-case the rest. Low-count foreign
// noise ("Fort Worth" in KE) is handled by the >=3 floor below.
const CITY_ALIAS = {
  KE: { "city centre sublocation": "Nairobi", "kilimani": "Nairobi", "kilimani division": "Nairobi", "karen": "Nairobi", "karen ward": "Nairobi", "karen hardy": "Nairobi", "highridge division": "Nairobi", "highridge": "Nairobi", "mugumo-ini ward": "Nairobi", "westlands": "Nairobi", "parklands": "Nairobi", "lavington": "Nairobi", "kileleshwa": "Nairobi", "runda": "Nairobi", "langata": "Nairobi", "embakasi": "Nairobi", "cbd": "Nairobi", "upper hill": "Nairobi", "upperhill": "Nairobi", "ngong road": "Nairobi", "nairobi city": "Nairobi" },
  NG: { "lekki": "Lagos", "ikeja": "Lagos", "victoria island": "Lagos", "vi": "Lagos", "ikoyi": "Lagos", "somolu": "Lagos", "shomolu": "Lagos", "yaba": "Lagos", "surulere": "Lagos", "ajah": "Lagos", "lagos island": "Lagos", "gbagada": "Lagos", "maryland": "Lagos", "oshodi": "Lagos", "apapa": "Lagos", "ikorodu": "Lagos", "wuse": "Abuja", "wuse 2": "Abuja", "gwarinpa": "Abuja", "garki": "Abuja", "maitama": "Abuja", "asokoro": "Abuja", "kubwa": "Abuja", "lugbe": "Abuja", "jabi": "Abuja", "utako": "Abuja", "central business district": "Abuja" },
  EG: { "القاهرة": "Cairo", "cairo": "Cairo", "بولاق": "Cairo", "باب اللوق": "Cairo", "الموسكى": "Cairo", "مدينة نصر": "Cairo", "nasr city": "Cairo", "new cairo": "Cairo", "new cairo 1": "Cairo", "el nozha": "Cairo", "heliopolis": "Cairo", "مصر الجديدة": "Cairo", "maadi": "Cairo", "المعادي": "Cairo", "zamalek": "Cairo", "الزمالك": "Cairo", "6th of october": "Cairo", "6 october": "Cairo", "6th of october city": "Cairo", "shubra": "Cairo", "shubra el kheima": "Cairo", "el mokattam": "Cairo", "obour": "Cairo", "madinaty": "Cairo", "sheikh zayed": "Cairo", "sheikh zayed city": "Cairo", "الإسكندرية": "Alexandria", "alex": "Alexandria", "الجيزة": "Giza", "giza": "Giza", "al giza": "Giza" },
  GH: { "awudome estates": "Accra", "greater accra region": "Accra", "greater accra": "Accra", "east legon": "Accra", "labadi, accra": "Accra", "labadi": "Accra", "ministries": "Accra", "south industrial area": "Accra", "osu": "Accra", "cantonments": "Accra", "airport residential": "Accra", "spintex": "Accra", "dansoman": "Accra", "adabraka": "Accra" },
};
// obvious non-African cities that show up misattributed (store country is African, city isn't) — drop them
const FOREIGN = new Set(["london", "paris", "new york city", "new york", "los angeles", "chicago", "st albans", "newark", "birmingham", "manchester", "dublin", "amsterdam", "berlin", "madrid", "rome", "sydney", "toronto", "fort worth", "claymont", "jackson", "chatsworth", "clifton", "hanover", "colonia", "mountain view", "first avenue", "villeneuve d ascq"]);
const titleCaseAscii = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
function cleanCity(country, city) {
  const s = (city || "").trim(); if (!s) return "";
  const low = s.toLowerCase().replace(/\s+/g, " ");
  const m = CITY_ALIAS[country];
  const out = m && m[low] ? m[low] : (/[^\x00-\x7F]/.test(s) ? "" : titleCaseAscii(low));   // drop unmapped non-ASCII
  return out && FOREIGN.has(out.toLowerCase()) ? "" : out;                                   // drop foreign noise
}

try {
  // ── 1) world-points: top 90 countries by live store count ──────────────────────────────────────
  const pRows = await sql`
    SELECT upper(country) iso2, count(*)::int n
    FROM imported_stores
    WHERE published AND country IS NOT NULL AND length(country)=2 AND ${LIVE}
    GROUP BY 1 HAVING count(*) >= 15 ORDER BY n DESC LIMIT 110`;
  const pm = {};
  for (const r of pRows) { const k = alias(r.iso2); pm[k] = (pm[k] || 0) + r.n; }
  const points = Object.entries(pm).map(([iso2, n]) => ({ iso2, n })).sort((a, b) => b.n - a.n).slice(0, 90);
  writeFileSync("lib/world-points-snapshot.json", JSON.stringify(points));
  console.log(`world-points-snapshot.json  ${points.length} countries  ${sizeKB("lib/world-points-snapshot.json")}`);

  // ── 2) world-stores: up to 16 recent, named, live stores per country (>=40) ─────────────────────
  const sRows = await sql`
    WITH ranked AS (
      SELECT upper(country) c, domain, name, platform,
        row_number() OVER (PARTITION BY upper(country) ORDER BY launched_at DESC NULLS LAST) rn,
        count(*) OVER (PARTITION BY upper(country)) cnt
      FROM imported_stores
      WHERE published AND country IS NOT NULL AND length(country)=2 AND name IS NOT NULL AND btrim(name) <> '' AND ${LIVE}
    )
    SELECT c, domain, name, platform FROM ranked WHERE rn <= 24 AND cnt >= 40 ORDER BY c, rn`;
  const byC = {};
  for (const r of sRows) (byC[alias(r.c)] ??= []).push({ c: alias(r.c), d: r.domain, n: r.name, g: grp(r.platform) });
  const stores = [];
  for (const list of Object.values(byC)) { const seen = new Set(); let k = 0; for (const r of list) { if (seen.has(r.d)) continue; seen.add(r.d); stores.push(r); if (++k >= 16) break; } }
  writeFileSync("lib/world-stores-snapshot.json", JSON.stringify(stores));
  console.log(`world-stores-snapshot.json  ${Object.keys(byC).length} countries, ${stores.length} stores  ${sizeKB("lib/world-stores-snapshot.json")}`);

  // ── 3) geo-timeline: per-country monthly launches by CMS + per-city monthly (focus markets) ─────
  const months = []; { let y = 2015, m = 1; const now = new Date(), ey = now.getUTCFullYear(), em = now.getUTCMonth() + 1;
    while (y < ey || (y === ey && m <= em)) { months.push(`${y}-${String(m).padStart(2, "0")}`); m++; if (m > 12) { m = 1; y++; } } }
  const mi = {}; months.forEach((mm, i) => (mi[mm] = i)); const N = months.length;
  const gCase = sql`CASE WHEN lower(platform)='woocommerce' THEN 'w' WHEN lower(platform)='shopify' OR platform IS NULL THEN 's' ELSE 'r' END`;
  const cRows = await sql`
    WITH base AS (
      SELECT upper(country) c, ${gCase} g, to_char(date_trunc('month',launched_at),'YYYY-MM') m
      FROM imported_stores
      WHERE published AND launched_at >= '2015-01-01' AND launched_at < now() AND country IS NOT NULL AND length(country)=2 AND ${LIVE}
    )
    SELECT c, g, m, count(*)::int n FROM base GROUP BY 1,2,3`;
  const countries = {};
  for (const r of cRows) { const c = alias(r.c), i = mi[r.m]; if (i == null) continue;
    (countries[c] ??= { s: Array(N).fill(0), w: Array(N).fill(0), r: Array(N).fill(0) })[r.g][i] += r.n; }
  for (const [c, o] of Object.entries(countries)) { let t = 0; for (const k of ["s", "w", "r"]) for (const v of o[k]) t += v; if (t < 40) delete countries[c]; }

  const FOCUS_CITY = ["ZA", "KE", "NG", "EG", "GH"];
  const cityRows = await sql`
    SELECT upper(country) c, city, to_char(date_trunc('month',launched_at),'YYYY-MM') m, count(*)::int n
    FROM imported_stores
    WHERE published AND launched_at >= '2015-01-01' AND country = ANY(${FOCUS_CITY}) AND city IS NOT NULL AND btrim(city) <> '' AND ${LIVE}
    GROUP BY 1,2,3`;
  const cityAgg = {};
  for (const r of cityRows) { const i = mi[r.m]; if (i == null) continue; const name = cleanCity(r.c, r.city); if (!name) continue; ((cityAgg[r.c] ??= {})[name] ??= Array(N).fill(0))[i] += r.n; }
  const cities = {};
  for (const [c, obj] of Object.entries(cityAgg)) {
    const tops = Object.entries(obj).map(([city, arr]) => [city, arr, arr.reduce((a, b) => a + b, 0)])
      .filter(([, , total]) => total >= 3).sort((a, b) => b[2] - a[2]).slice(0, 12);          // drop tiny/noise cities
    cities[c] = Object.fromEntries(tops.map(([city, arr]) => [city, arr]));
  }
  writeFileSync("lib/geo-timeline-snapshot.json", JSON.stringify({ months, countries, cities }));
  console.log(`geo-timeline-snapshot.json  ${N} months, ${Object.keys(countries).length} countries, ${Object.keys(cities).length} city-markets  ${sizeKB("lib/geo-timeline-snapshot.json")}`);
  console.log("Done. Commit the updated lib/*-snapshot.json files to deploy the refreshed map.");
} finally {
  await sql.end();
}
