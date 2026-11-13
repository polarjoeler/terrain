/**
 * crux-country — give crux-ranked stores a country backed by evidence.
 *
 * ingest-ranked.mjs stamps each store with the CrUX market whose top list it was read from. That's
 * where people visit the site, not where the store is: douglas.pt and certideal.pt sit in Angola,
 * balenciaga.com in Japan, cartier.com in Morocco. 2026-11-13: 2,381 of the 7,090 crux-ranked rows on
 * a country-code domain disagreed with it, 106 of them published into African dashboards.
 *
 * Two passes, no page fetches:
 *   1. Country-code domain (.co.za, .pt, .kr …, not vanity endings like .io/.co/.tv) → that country.
 *      country_source = 'cctld'.
 *   2. Generic domain (.com, .shop, .store …): compare the store's rank bucket across CrUX country
 *      lists (the markets we ingested, plus the countries most global brands come from).
 *        only in its market's list, or clearly best-ranked there   → keep it      'crux-home'
 *        clearly best-ranked in ONE other country                  → that country 'crux-home'
 *        tied at the top across several countries                  → country NULL 'crux-global'
 *        not in this month's lists at all                          → untouched (no evidence either way)
 *   Rows whose country came from real evidence (manual, shop_meta, shopify_meta, storefront,
 *   payment_geo, disputed) are never touched. Every change records country_source, so it's auditable
 *   and reversible: confirm-other-cms trusts 'cctld' and 'crux-home' for crux-ranked rows.
 *
 *   node --env-file=.env.local scripts/crux-country.mjs --dry [--month 202609] [--cache /tmp/crux]
 *   node --env-file=.env.local scripts/crux-country.mjs            # writes
 */
import postgres from "postgres";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const MONTH = arg("--month", "202609");
const CACHE = arg("--cache", "/tmp/crux-lists");
// Countries whose lists we compare: the markets ingest-ranked reads, plus where global brands rank.
const MARKETS = "JP ZA KR EG KE NG MA AO CI TZ GH TN UG DZ SN BW BF ET BJ CD CM CG GN GA CV BI GM LR DJ CF GW KM".split(" ");
const ORIGINS = "US GB FR DE IT ES PT BR NL BE CH CA AU IN AE SA TR PL SE MX IE AT".split(" ");
const LISTS = [...new Set([...MARKETS, ...ORIGINS])];
const AFRICA = new Set(MARKETS.filter((c) => c !== "JP" && c !== "KR"));
// Country-code endings used as generic/vanity names — not evidence of where a store is.
const VANITY = new Set("io co me tv ai cc ws fm gg to sh ly so la st gl vc ag nu tk ml ga cf gq gs su ac im eu asia".split(" "));
const TRUSTED_SOURCES = ["manual", "shop_meta", "shopify_meta", "storefront", "payment_geo", "disputed"];

const host = (d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/:].*$/, "").replace(/^www\./, "");
export function ccFromDomain(d) {
  const last = host(d).split(".").at(-1);
  if (!last || last.length !== 2 || VANITY.has(last)) return null;
  return last === "uk" ? "GB" : last.toUpperCase();
}

async function list(cc) {
  if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });
  const f = join(CACHE, `${cc.toLowerCase()}-${MONTH}.csv.gz`);
  if (!existsSync(f)) {
    const r = await fetch(`https://raw.githubusercontent.com/zakird/crux-top-lists/main/data/country/${cc.toLowerCase()}/${MONTH}.csv.gz`);
    if (!r.ok) { console.warn(`  ! CrUX ${cc}/${MONTH}: HTTP ${r.status} — skipped`); return null; }
    writeFileSync(f, Buffer.from(await r.arrayBuffer()));
  }
  return f;
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 2, connection: { statement_timeout: 180000 } });
  try {
    const rows = await sql`
      SELECT domain, upper(country) AS c, published, country_source FROM imported_stores
       WHERE source = 'crux-ranked' AND coalesce(country_source, '') <> ALL(${TRUSTED_SOURCES})
         AND country_source IS DISTINCT FROM 'cctld' AND country_source IS DISTINCT FROM 'crux-home'
         AND country_source IS DISTINCT FROM 'crux-global'`;
    console.log(`${rows.length.toLocaleString()} crux-ranked rows without an evidence-backed country`);

    const plan = [];            // { domain, was, to, how, published }
    const generic = new Map();  // host → row
    for (const r of rows) {
      const cc = ccFromDomain(r.domain);
      if (cc) { if (cc !== r.c) plan.push({ ...r, to: cc, how: "cctld" }); else plan.push({ ...r, to: cc, how: "cctld", same: true }); }
      else generic.set(host(r.domain), r);
    }

    // Pass 2: rank buckets for every generic domain across the comparison lists.
    const ranks = new Map();    // host → { cc: rank }
    for (const cc of LISTS) {
      const f = await list(cc);
      if (!f) continue;
      let seen = 0;
      const rl = createInterface({ input: createReadStream(f).pipe(createGunzip()) });
      for await (const line of rl) {
        const i = line.lastIndexOf(",");
        if (i < 0) continue;
        const h = host(line.slice(0, i));
        if (!generic.has(h)) continue;
        const rank = Number(line.slice(i + 1));
        const m = ranks.get(h) || {};
        if (!m[cc] || rank < m[cc]) m[cc] = rank;
        ranks.set(h, m); seen++;
      }
      process.stdout.write(`${cc}:${seen} `);
    }
    console.log("");

    let unseen = 0;
    for (const [h, r] of generic) {
      const m = ranks.get(h);
      if (!m) { unseen++; continue; }
      const best = Math.min(...Object.values(m));
      const top = Object.keys(m).filter((k) => m[k] === best);
      const n = Object.keys(m).length;
      if (top.length === 1 && top[0] === r.c) plan.push({ ...r, to: r.c, how: "crux-home", same: true });
      else if (top.length === 1) plan.push({ ...r, to: top[0], how: "crux-home" });
      // A tie only among African neighbours (ZA + BW, MA + DZ) that includes the store's market is a
      // regional site, not a global one: keep the market. Any tie with JP/KR or a brand-origin
      // country is global.
      else if (top.includes(r.c) && top.length <= 3 && top.every((k) => AFRICA.has(k))) plan.push({ ...r, to: r.c, how: "crux-home", same: true });
      else plan.push({ ...r, to: null, how: "crux-global" });
    }

    const moved = plan.filter((p) => !p.same);
    const tally = (xs, f) => Object.entries(xs.reduce((a, p) => ((a[f(p)] = (a[f(p)] || 0) + 1), a), {})).sort((a, b) => b[1] - a[1]);
    console.log(`\nconfirmed in place: ${plan.length - moved.length} · moved/cleared: ${moved.length} · no CrUX evidence this month (left alone): ${unseen}`);
    console.log("by method:", tally(plan, (p) => `${p.how}${p.same ? "=" : "→"}`).map(([k, v]) => `${k}${v}`).join("  "));
    console.log("moves (was→to):", tally(moved, (p) => `${p.c}→${p.to ?? "global"}`).slice(0, 30).map(([k, v]) => `${k}:${v}`).join(" "));
    const pubOut = moved.filter((p) => p.published);
    console.log(`published rows that change country: ${pubOut.length}`);
    for (const p of pubOut.slice(0, 20)) console.log(`   ${p.domain.padEnd(34)} ${p.c} → ${p.to ?? "global (NULL)"}  [${p.how}]`);
    if (process.env.CRUX_SAMPLE) {
      const want = process.env.CRUX_SAMPLE;   // e.g. "ZA>global" or "EG>SA"
      const xs = moved.filter((p) => `${p.c}>${p.to ?? "global"}` === want);
      for (const p of xs.sort(() => Math.random() - 0.5).slice(0, 25)) console.log(`   ${p.published ? "P" : " "} ${p.domain.padEnd(36)} ${JSON.stringify(ranks.get(host(p.domain)) || {})}`);
    }
    if (DRY) { console.log("\nDRY — nothing written."); return; }

    // Set-based writes: one UPDATE per (target, method).
    const groups = new Map();
    for (const p of plan) { const k = `${p.to ?? ""}|${p.how}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p.domain); }
    let w = 0;
    for (const [k, doms] of groups) {
      const [to, how] = k.split("|");
      for (let i = 0; i < doms.length; i += 2000) {
        const r = await sql`UPDATE imported_stores SET country = ${to || null}, country_source = ${how}, country_checked_at = now()
          WHERE domain = ANY(${doms.slice(i, i + 2000)}) AND source = 'crux-ranked'
            AND coalesce(country_source, '') <> ALL(${TRUSTED_SOURCES})`;
        w += r.count;
      }
    }
    console.log(`wrote ${w.toLocaleString()} rows.`);
  } finally { await sql.end(); }
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error("crux-country failed:", e.message); process.exit(1); });
