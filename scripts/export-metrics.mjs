/**
 * export-metrics — reads metrics_daily + store_rollup (scripts/build-rollups.mjs) and writes the
 * compact per-day JSON the Terrain HQ "Metrics" tab charts. Read-only.
 *
 *   node --env-file=.env.local scripts/export-metrics.mjs --out DIR [--days 120]
 *
 * Writes DIR/<YYYY-MM-DD>.json for each closed SAST day and DIR/live.json (the current rolling
 * rollup, 24h flows). Each file: { day, kind, geos, platforms, m: { metric: { "g,p": n } } } where
 * g/p index into geos/platforms; zero cells are left out. Countries and platforms are bucketed so a
 * day stays ~10KB (the HQ keeps one doc per day).
 */
import postgres from "postgres";
import { mkdirSync, writeFileSync } from "fs";

const args = process.argv.slice(2);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const OUT = opt("--out", null);
const DAYS = Number(opt("--days", 120));
if (!OUT && import.meta.url === `file://${process.argv[1]}`) { console.error("--out DIR required"); process.exit(1); }

const AFRICA = new Set("DZ,AO,BJ,BW,BF,BI,CV,CM,CF,TD,KM,CG,CD,CI,DJ,EG,GQ,ER,SZ,ET,GA,GM,GH,GN,GW,KE,LS,LR,LY,MG,MW,ML,MR,MU,MA,MZ,NA,NE,NG,RW,ST,SN,SC,SL,SO,ZA,SS,SD,TZ,TG,TN,UG,ZM,ZW,RE,YT,SH".split(","));
const EUROPE = new Set("AL,AD,AT,BY,BE,BA,BG,HR,CY,CZ,DK,EE,FI,FR,DE,GR,HU,IS,IE,IT,XK,LV,LI,LT,LU,MT,MD,MC,ME,NL,MK,NO,PL,PT,RO,RU,SM,RS,SK,SI,ES,SE,CH,UA,VA,GB".split(","));
export const GEOS = ["ZA", "KE", "NG", "Rest of Africa", "JP", "US", "UK", "Rest of Europe", "Rest of world", "Unknown"];
export const PLATFORMS = ["Shopify", "WooCommerce", "WordPress", "Wix", "Squarespace", "Webflow", "BigCommerce", "Selar", "Other", "Unknown"];
const geo = (c) => {
  if (!c) return 9;
  if (c === "ZA") return 0; if (c === "KE") return 1; if (c === "NG") return 2; if (AFRICA.has(c)) return 3;
  if (c === "JP") return 4; if (c === "US") return 5; if (c === "GB" || c === "UK") return 6; if (EUROPE.has(c)) return 7;
  return 8;
};
const PMAP = { shopify: 0, woocommerce: 1, wordpress: 2, wix: 3, squarespace: 4, webflow: 5, bigcommerce: 6, selar: 7 };
const plat = (p) => (!p || p === "custom" ? 9 : PMAP[p] ?? 8);

export function pack(rows, day, kind) {
  const m = {};
  for (const r of rows) {
    const cell = `${geo(r.country)},${plat(r.platform)}`;
    for (const [k, v] of Object.entries(r.m)) {
      if (typeof v !== "number" || !v) continue;
      (m[k] ??= {})[cell] = (m[k][cell] || 0) + v;
    }
  }
  return { day, kind, geos: GEOS, platforms: PLATFORMS, m };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
const sql = isMain ? postgres(process.env.DATABASE_URL, { prepare: false, max: 1, connection: { default_transaction_read_only: "on", statement_timeout: 120000 } }) : null;
if (isMain) try {
  mkdirSync(OUT, { recursive: true });
  const rows = await sql`SELECT day::text day, country, platform, m FROM metrics_daily
    WHERE day >= (now() AT TIME ZONE 'Africa/Johannesburg')::date - ${DAYS}::int ORDER BY day`;
  const byDay = new Map();
  for (const r of rows) { if (!byDay.has(r.day)) byDay.set(r.day, []); byDay.get(r.day).push(r); }
  for (const [day, rs] of byDay) {
    const full = rs.some((r) => "live" in r.m);
    writeFileSync(`${OUT}/${day}.json`, JSON.stringify(pack(rs, day, full ? "day" : "discovery-only")));
  }
  const live = await sql`SELECT country, platform, m, built_at FROM store_rollup`;
  if (live.length) {
    const doc = pack(live, null, "live");
    doc.builtAt = new Date(Math.max(...live.map((r) => new Date(r.built_at).getTime()))).toISOString();
    writeFileSync(`${OUT}/live.json`, JSON.stringify(doc));
  }
  console.log(JSON.stringify({ days: byDay.size, full: [...byDay.values()].filter((rs) => rs.some((r) => "live" in r.m)).length, live: live.length > 0 }));
} finally {
  await sql.end();
}
