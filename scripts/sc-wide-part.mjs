#!/usr/bin/env node
/** sc-wide-part — land one part file from the WIDE StoreCensus pull.
 *
 *  The wide pull re-reads every market with all 129 API fields (flattened in the browser), so most
 *  rows already exist here. That makes this mostly an UPDATE pass, and `import-storecensus.mjs`
 *  writes every field as COALESCE(existing, incoming) — our own probe data always wins and is never
 *  overwritten. Only genuinely new domains (chiefly US/CA) need placing afterwards.
 *
 *  Three steps:
 *    1. pass 1 — import with country and pays STRIPPED, --unpublished. Country because the provider
 *       label is unreliable on the generic-TLD tail; pays because cleanPays must judge gateways
 *       against the REAL country (it strips Shopify Payments outside its ~40 supported countries).
 *    2. derive country for rows still null, grouped by (country, source), then publish those.
 *    3. pass 2 — re-import ONLY the newly placed rows, now carrying their derived country, so
 *       cleanPays runs correctly and payments land for them. Existing rows skip this: their
 *       payments are already set and COALESCE protects them.
 *
 *    node --env-file=.env.local scripts/sc-wide-part.mjs ~/Downloads/sc_wide_p01.ndjson
 */
import postgres from "postgres";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { join, basename } from "path";

const FILE = process.argv[2];
if (!FILE || !existsSync(FILE)) { console.error("usage: sc-wide-part.mjs <part.ndjson>"); process.exit(2); }
const NAME = basename(FILE).replace(/\.ndjson$/, "");
const TMP = tmpdir();
const node = process.execPath;
const run = (args) => execFileSync(node, ["--env-file=.env.local", ...args], { cwd: process.cwd(), encoding: "utf8" });

const CCTLD = JSON.parse(readFileSync(new URL("./cctld-map.json", import.meta.url), "utf8"));
const CCY = CCTLD.__ccy; delete CCTLD.__ccy;
const fromCctld = (d) => { const l = (d || "").toLowerCase();
  for (const [t, c] of Object.entries(CCTLD)) if (l.endsWith("." + t)) return c; return null; };

// US/CA are the one place the provider's own country label is worth using — but only CORROBORATED.
// A US `.com` store has no ccTLD and USD pins nothing, so 93% of the US pull would otherwise bank.
// The provider's US label is also its most trustworthy: when we audited stores it wrongly called
// South African, they turned out to BE American. Still, we require a second, independent signal —
// a real US state code or a US-shaped ZIP — before accepting it. Measured: 65.6% of US rows qualify.
const US_STATES = new Set("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR".split(" "));
const CA_PROV = new Set("ON QC BC AB MB SK NS NB NL PE YT NT NU".split(" "));
function corroborated(r) {
  const st = String(r.state || "").trim().toUpperCase();
  const zip = String(r.zip || "").trim();
  if (r.sc_country === "US" && (US_STATES.has(st) || /^\d{5}(-\d{4})?$/.test(zip))) return "US";
  if (r.sc_country === "CA" && (CA_PROV.has(st) || /^[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d$/.test(zip))) return "CA";
  return null;
}
const chunks = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

async function main() {
  const rows = readFileSync(FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const p1 = join(TMP, `${NAME}_p1.ndjson`);
  writeFileSync(p1, rows.map((r) => { const { sc_country, country, pays, ...rest } = r; return JSON.stringify(rest); }).join("\n") + "\n");
  console.log(`${NAME}: ${rows.length.toLocaleString()} rows`);
  console.log(run(["scripts/import-storecensus.mjs", p1, "--unpublished"]).trim().split("\n")[0]);

  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3, idle_timeout: 20 });
  try {
    const want = rows.map((r) => r.d.toLowerCase());
    // only rows still unplaced need work; existing rows already carry a derived country
    const todo = [];
    for (const ch of chunks(want, 5000))
      todo.push(...await sql`SELECT domain, UPPER(currency) ccy FROM imported_stores
        WHERE lower(domain) = ANY(${ch}) AND country IS NULL`);
    const corr = new Map();
    for (const r of rows) { const cc = corroborated(r); if (cc) corr.set(r.d.toLowerCase(), cc); }
    if (!todo.length) { console.log(`${NAME}: nothing new to place`); return; }
    const groups = {};
    for (const r of todo) {
      const tld = fromCctld(r.domain);
      const label = corr.get(r.domain.toLowerCase());
      const cc = tld ?? CCY[r.ccy] ?? label ?? null;
      if (!cc) continue;
      const via = tld ? "ccTLD" : (CCY[r.ccy] ? `currency:${r.ccy}` : "label+geo");
      (groups[`${cc}|${via}`] ??= []).push(r.domain);
    }
    let placed = 0;
    for (const [key, doms] of Object.entries(groups)) {
      const [cc, via] = key.split("|");
      for (const ch of chunks(doms, 5000)) {
        const r = await sql`UPDATE imported_stores SET country = ${cc}, country_source = COALESCE(country_source, ${via})
          WHERE domain = ANY(${ch}) AND country IS NULL RETURNING 1`;
        placed += r.length;
      }
    }
    let pub = 0;
    for (const ch of chunks(want, 5000)) {
      const r = await sql`UPDATE imported_stores SET published = true
        WHERE lower(domain) = ANY(${ch}) AND country IS NOT NULL AND platform = 'Shopify' AND NOT published RETURNING 1`;
      pub += r.length;
    }
    // pass 2 only for what we just placed, so cleanPays sees the real country
    const placedSet = new Set();
    for (const ch of chunks(want, 5000))
      (await sql`SELECT lower(domain) d, country FROM imported_stores
        WHERE lower(domain) = ANY(${ch}) AND country IS NOT NULL`).forEach((x) => placedSet.set?.(x.d, x.country) ?? placedSet.add(x.d));
    const byDom = new Map();
    for (const ch of chunks(want, 5000))
      (await sql`SELECT lower(domain) d, country FROM imported_stores
        WHERE lower(domain) = ANY(${ch}) AND country IS NOT NULL`).forEach((x) => byDom.set(x.d, x.country));
    const p2rows = rows.filter((r) => byDom.has(r.d.toLowerCase()) && r.pays)
      .map((r) => { const { sc_country, ...rest } = r; return JSON.stringify({ ...rest, country: byDom.get(r.d.toLowerCase()) }); });
    console.log(`${NAME}: placed ${placed.toLocaleString()}, published ${pub.toLocaleString()}, banked ${(todo.length - placed).toLocaleString()}`);
    if (p2rows.length) {
      const p2 = join(TMP, `${NAME}_p2.ndjson`);
      writeFileSync(p2, p2rows.join("\n") + "\n");
      console.log(run(["scripts/import-storecensus.mjs", p2, "--unpublished"]).trim().split("\n")[0].replace("imported", "pass2"));
    }
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
