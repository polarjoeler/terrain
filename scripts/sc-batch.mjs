#!/usr/bin/env node
/** sc-batch — land one StoreCensus country-batch safely. Two modes.
 *
 *  Why this exists: a raw StoreCensus pull cannot be imported as-is. Its `country` field is
 *  unreliable on the generic-TLD tail (measured: of 7,174 rows it called South African, ~99% were
 *  foreign), so we strip it and re-derive. And an import whose country is unknown must NOT be
 *  published — an unplaceable row pollutes the insights counts, the browse-snapshot top-N cut and
 *  the launch floor.
 *
 *  --stage  reads the pulled NDJSON, finds which domains are genuinely new, and writes two files:
 *           <out>/<name>_pass1.ndjson   the net-new rows with `sc_country` and `pays` REMOVED
 *                                       (country because we distrust it; pays because cleanPays
 *                                        needs the real country to judge which gateways are
 *                                        geographically possible)
 *           <out>/<name>_domains.txt    the net-new domain list, for the land step
 *           Read-only against the DB.
 *
 *  --land   runs AFTER `import-storecensus.mjs <pass1> --unpublished` and does three things:
 *           1. VERIFIES the import actually landed banked. This is not paranoia: an uncommitted
 *              `--unpublished` patch was once reverted mid-session and 170,004 rows went live with
 *              no country. Never trust the flag — count the rows.
 *           2. Derives country from ccTLD, then from a SINGLE-COUNTRY currency. Shared units (EUR,
 *              USD, XCD) are excluded because they cannot pin a country. Grouped UPDATEs, one per
 *              (country, source) — row-by-row would be ~1 round trip per row (123k rows ≈ 10h that
 *              way, ≈3 min batched).
 *           3. Publishes only rows that got a country AND have a known platform.
 *
 *    node --env-file=.env.local scripts/sc-batch.mjs --stage --file ~/Downloads/sc_eu_b1.ndjson --name b1
 *    node --env-file=.env.local scripts/import-storecensus.mjs /tmp/b1_pass1.ndjson --unpublished
 *    node --env-file=.env.local scripts/sc-batch.mjs --land --name b1
 */
import postgres from "postgres";
import { readFileSync, writeFileSync } from "fs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const STAGE = process.argv.includes("--stage");
const LAND = process.argv.includes("--land");
const NAME = arg("--name", null);
const FILE = arg("--file", null);
const OUT = arg("--out", "/tmp");
const PUBLISH_PLATFORMS = ["Shopify"];   // only platforms we trust from this provider

// ccTLD → ISO country. Covers every market we pull; add a row to add a market.
const CCTLD = {
  za:"ZA",ke:"KE",ng:"NG",eg:"EG",ma:"MA",tn:"TN",dz:"DZ",mu:"MU",tz:"TZ",bw:"BW",ug:"UG",gh:"GH",
  zw:"ZW",mw:"MW",sn:"SN",mz:"MZ",et:"ET",ci:"CI",ls:"LS",na:"NA",rw:"RW",zm:"ZM",ao:"AO",cm:"CM",
  bj:"BJ",bf:"BF",cd:"CD",cg:"CG",cv:"CV",dj:"DJ",er:"ER",sz:"SZ",gm:"GM",gn:"GN",gw:"GW",lr:"LR",
  mg:"MG",mr:"MR",ne:"NE",sc:"SC",sl:"SL",ss:"SS",sd:"SD",tg:"TG",bi:"BI",td:"TD",km:"KM",st:"ST",
  ae:"AE",sa:"SA",il:"IL",tr:"TR",qa:"QA",kw:"KW",bh:"BH",om:"OM",jo:"JO",lb:"LB",
  jp:"JP",cn:"CN",hk:"HK",sg:"SG",my:"MY",th:"TH",id:"ID",ph:"PH",vn:"VN",tw:"TW",kr:"KR",pk:"PK",
  bd:"BD",lk:"LK",np:"NP",kh:"KH",mm:"MM",la:"LA",bn:"BN",mv:"MV",bt:"BT",mn:"MN",mo:"MO",in:"IN",
  au:"AU",nz:"NZ",fj:"FJ",pg:"PG",
  gb:"GB",uk:"GB",de:"DE",fr:"FR",it:"IT",es:"ES",nl:"NL",pl:"PL",se:"SE",be:"BE",ch:"CH",at:"AT",
  dk:"DK",no:"NO",fi:"FI",ie:"IE",pt:"PT",cz:"CZ",gr:"GR",ro:"RO",hu:"HU",sk:"SK",si:"SI",hr:"HR",
  bg:"BG",lt:"LT",lv:"LV",ee:"EE",lu:"LU",cy:"CY",mt:"MT",is:"IS",rs:"RS",ba:"BA",mk:"MK",al:"AL",
  me:"ME",md:"MD",ua:"UA",by:"BY",ru:"RU",li:"LI",mc:"MC",ad:"AD",sm:"SM",gi:"GI",gg:"GG",je:"JE",
  im:"IM",fo:"FO",gl:"GL",
  br:"BR",mx:"MX",ar:"AR",cl:"CL",co:"CO",pe:"PE",ec:"EC",uy:"UY",py:"PY",bo:"BO",ve:"VE",cr:"CR",
  pa:"PA",gt:"GT",do:"DO",sv:"SV",hn:"HN",ni:"NI",cu:"CU",jm:"JM",tt:"TT",pr:"PR",bb:"BB",bs:"BS",
  bz:"BZ",gy:"GY",sr:"SR",ht:"HT",aw:"AW",cw:"CW",ky:"KY",bm:"BM",vg:"VG",tc:"TC",ag:"AG",dm:"DM",
  gd:"GD",kn:"KN",lc:"LC",vc:"VC",
  ge:"GE",am:"AM",az:"AZ",kz:"KZ",uz:"UZ",kg:"KG",tj:"TJ",tm:"TM",af:"AF",
};
// SINGLE-COUNTRY currencies only. EUR/USD/XCD/XOF/XAF are shared and must never pin a country.
const CCY = {
  ZAR:"ZA",NGN:"NG",KES:"KE",GHS:"GH",EGP:"EG",MAD:"MA",TND:"TN",DZD:"DZ",MZN:"MZ",TZS:"TZ",
  UGX:"UG",RWF:"RW",ZMW:"ZM",MUR:"MU",BWP:"BW",NAD:"NA",ETB:"ET",AOA:"AO",KWD:"KW",QAR:"QA",
  BHD:"BH",OMR:"OM",AED:"AE",ILS:"IL",TRY:"TR",JPY:"JP",INR:"IN",CNY:"CN",HKD:"HK",SGD:"SG",
  MYR:"MY",THB:"TH",IDR:"ID",PHP:"PH",VND:"VN",TWD:"TW",KRW:"KR",PKR:"PK",BDT:"BD",LKR:"LK",
  NPR:"NP",KHR:"KH",MMK:"MM",LAK:"LA",BND:"BN",MVR:"MV",MNT:"MN",AUD:"AU",NZD:"NZ",FJD:"FJ",
  GBP:"GB",PLN:"PL",SEK:"SE",CHF:"CH",DKK:"DK",NOK:"NO",CZK:"CZ",RON:"RO",HUF:"HU",BGN:"BG",
  ISK:"IS",RSD:"RS",BAM:"BA",MKD:"MK",ALL:"AL",MDL:"MD",UAH:"UA",BYN:"BY",RUB:"RU",
  BRL:"BR",MXN:"MX",ARS:"AR",CLP:"CL",COP:"CO",PEN:"PE",UYU:"UY",PYG:"PY",BOB:"BO",VES:"VE",
  CRC:"CR",GTQ:"GT",DOP:"DO",HNL:"HN",NIO:"NI",JMD:"JM",TTD:"TT",BBD:"BB",BSD:"BS",BZD:"BZ",
  GYD:"GY",SRD:"SR",HTG:"HT",AWG:"AW",KYD:"KY",BMD:"BM",
  GEL:"GE",AMD:"AM",AZN:"AZ",KZT:"KZ",UZS:"UZ",KGS:"KG",TJS:"TJ",AFN:"AF",
};
const fromCctld = (d) => {
  const l = (d || "").toLowerCase();
  for (const [t, c] of Object.entries(CCTLD)) if (l.endsWith("." + t)) return c;
  return null;
};
const chunks = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

async function stage(sql) {
  const rows = readFileSync(FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const present = new Set();
  for (const ch of chunks(rows.map((r) => r.d.toLowerCase()), 5000))
    (await sql`SELECT lower(domain) d FROM imported_stores WHERE lower(domain) = ANY(${ch})`)
      .forEach((g) => present.add(g.d));
  const neu = rows.filter((r) => !present.has(r.d.toLowerCase()));
  const byC = {};
  for (const r of rows) {
    const k = r.sc_country ?? r.country ?? "?";
    byC[k] ??= { t: 0, n: 0 }; byC[k].t++;
    if (!present.has(r.d.toLowerCase())) byC[k].n++;
  }
  console.log(`${NAME}: ${rows.length} rows, already ours ${rows.length - neu.length} (${((rows.length - neu.length) / rows.length * 100).toFixed(1)}%), NET NEW ${neu.length} (${(neu.length / rows.length * 100).toFixed(1)}%)`);
  for (const [k, v] of Object.entries(byC).sort((a, b) => b[1].t - a[1].t).slice(0, 12))
    console.log(`  ${k.padEnd(4)}${String(v.t).padStart(9)}${String(v.n).padStart(9)} new  ${(v.n / v.t * 100).toFixed(1)}%`);
  writeFileSync(`${OUT}/${NAME}_pass1.ndjson`,
    neu.map((r) => { const { sc_country, country, pays, ...rest } = r; return JSON.stringify(rest); }).join("\n") + "\n");
  writeFileSync(`${OUT}/${NAME}_domains.txt`, neu.map((r) => r.d).join("\n") + "\n");
  console.log(`staged ${neu.length} → ${OUT}/${NAME}_pass1.ndjson`);
}

async function land(sql) {
  const want = readFileSync(`${OUT}/${NAME}_domains.txt`, "utf8").split("\n").map((d) => d.trim().toLowerCase()).filter(Boolean);
  // 1. Never trust the --unpublished flag; count the rows.
  let pub = 0, tot = 0;
  for (const ch of chunks(want, 5000)) {
    const [r] = await sql`SELECT count(*)::int t, count(*) FILTER (WHERE published)::int p
      FROM imported_stores WHERE lower(domain) = ANY(${ch})`;
    tot += r.t; pub += r.p;
  }
  console.log(`verify: ${tot} rows present, ${pub} published (expect 0)`);
  if (pub > 0) {
    let fixed = 0;
    for (const ch of chunks(want, 2000)) {
      const r = await sql`UPDATE imported_stores SET published = false
        WHERE lower(domain) = ANY(${ch}) AND published AND country IS NULL RETURNING 1`;
      fixed += r.length;
    }
    console.log(`  !! banked ${fixed} that had landed published with no country`);
  }
  // 2. Derive country, grouped.
  const rows = [];
  for (const ch of chunks(want, 5000))
    rows.push(...await sql`SELECT domain, UPPER(currency) ccy FROM imported_stores
      WHERE lower(domain) = ANY(${ch}) AND country IS NULL`);
  const groups = {};
  for (const r of rows) {
    const tld = fromCctld(r.domain);
    const cc = tld ?? CCY[r.ccy] ?? null;
    if (!cc) continue;
    (groups[`${cc}|${tld ? "ccTLD" : `currency:${r.ccy}`}`] ??= []).push(r.domain);
  }
  let n = 0;
  for (const [key, doms] of Object.entries(groups)) {
    const [cc, via] = key.split("|");
    for (const ch of chunks(doms, 5000)) {
      const r = await sql`UPDATE imported_stores
        SET country = ${cc}, country_source = COALESCE(country_source, ${via})
        WHERE domain = ANY(${ch}) AND country IS NULL RETURNING 1`;
      n += r.length;
    }
  }
  // 3. Publish only what we could place.
  let p = 0;
  for (const ch of chunks(want, 5000)) {
    const r = await sql`UPDATE imported_stores SET published = true
      WHERE lower(domain) = ANY(${ch}) AND country IS NOT NULL
        AND platform = ANY(${PUBLISH_PLATFORMS}) AND NOT published RETURNING 1`;
    p += r.length;
  }
  console.log(`${NAME}: country derived ${n} of ${rows.length} (${(n / Math.max(rows.length, 1) * 100).toFixed(1)}%), published ${p}, banked ${rows.length - n}`);
}

async function main() {
  if (!NAME || (!STAGE && !LAND)) {
    console.error("usage: sc-batch.mjs --stage --file <ndjson> --name <id> [--out <dir>]\n       sc-batch.mjs --land --name <id> [--out <dir>]");
    process.exit(2);
  }
  if (STAGE && !FILE) { console.error("--stage needs --file"); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3, idle_timeout: 20 });
  try { if (STAGE) await stage(sql); else await land(sql); } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
