/** Recover the country for stores the VPS labelled just "Africa" (→ landed country
 *  NULL). Two deterministic signals, no network: first the domain's ccTLD (a .tn
 *  store is Tunisian), then the PRIMARY store currency (a ZAR store is South African
 *  even on a .com). Maps mirror CCTLD_CC / CCY_CC in sync-sheet.mjs. Genuinely
 *  country-less rows (pan-.africa, generic .so/.ly with no African currency) are
 *  left for the storefront re-probe (scripts/reprobe-null-country.mjs).
 *
 *    node --env-file=.env.local scripts/backfill-country-from-currency.mjs [--apply]
 *
 *  Dry-run by default (prints what it WOULD set); pass --apply to write.
 */
import postgres from "postgres";

const CCTLD_CC = {
  za: "ZA", ke: "KE", ng: "NG", eg: "EG", ma: "MA", tn: "TN", dz: "DZ", mu: "MU",
  tz: "TZ", bw: "BW", ug: "UG", gh: "GH", zw: "ZW", mw: "MW", sn: "SN", mz: "MZ",
  et: "ET", ci: "CI", ls: "LS", na: "NA", rw: "RW", zm: "ZM", ao: "AO", cm: "CM",
  bj: "BJ", bf: "BF", cd: "CD", cg: "CG", cv: "CV", dj: "DJ", er: "ER", sz: "SZ",
  gm: "GM", gn: "GN", gw: "GW", lr: "LR", mg: "MG", mr: "MR", ne: "NE", sc: "SC",
  sl: "SL", ss: "SS", sd: "SD", tg: "TG", bi: "BI", td: "TD", km: "KM", st: "ST",
  jp: "JP", ae: "AE", sa: "SA", il: "IL", tr: "TR", qa: "QA", kw: "KW", bh: "BH",
  om: "OM", jo: "JO", lb: "LB",
};
const CCY_CC = {
  ZAR: "ZA", NGN: "NG", KES: "KE", GHS: "GH", EGP: "EG", MAD: "MA", TND: "TN",
  DZD: "DZ", MZN: "MZ", TZS: "TZ", UGX: "UG", RWF: "RW", ZMW: "ZM", MUR: "MU",
  BWP: "BW", NAD: "NA", ETB: "ET", AOA: "AO", KWD: "KW", QAR: "QA", BHD: "BH",
  OMR: "OM", AED: "AE", ILS: "IL", TRY: "TR", JPY: "JP",
};
const APPLY = process.argv.includes("--apply");

function fromCctld(domain) {
  const d = (domain ?? "").toLowerCase();
  for (const [tld, cc] of Object.entries(CCTLD_CC)) if (d.endsWith("." + tld)) return cc;
  return null;
}

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3 });
try {
  const rows = await sql`
    SELECT domain, UPPER(currency) ccy FROM imported_stores
    WHERE published AND country IS NULL`;
  const plan = rows
    .map((r) => {
      const cc = fromCctld(r.domain) ?? CCY_CC[r.ccy] ?? null;
      const via = fromCctld(r.domain) ? "ccTLD" : CCY_CC[r.ccy] ? `currency:${r.ccy}` : null;
      return { domain: r.domain, cc, via };
    })
    .filter((x) => x.cc);

  const byCC = {}, byVia = {};
  for (const p of plan) { byCC[p.cc] = (byCC[p.cc] || 0) + 1; const v = p.via.split(":")[0]; byVia[v] = (byVia[v] || 0) + 1; }
  console.log(`${rows.length} null-country stores; ${plan.length} resolvable (${Object.entries(byVia).map(([k, v]) => `${k}:${v}`).join(", ")}):`);
  console.log("  " + Object.entries(byCC).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join("  "));
  const unresolved = rows.filter((r) => !fromCctld(r.domain) && !CCY_CC[r.ccy]);
  if (unresolved.length) console.log(`  (${unresolved.length} unresolved → storefront re-probe: ${unresolved.map((r) => r.domain).join(", ")})`);

  if (!APPLY) { console.log("\nDRY RUN — re-run with --apply to write."); }
  else {
    let n = 0;
    for (const p of plan) {
      await sql`UPDATE imported_stores SET country = ${p.cc} WHERE domain = ${p.domain} AND country IS NULL`;
      n++;
    }
    console.log(`\n✓ Applied: set country on ${n} stores.`);
  }
} finally { await sql.end(); }
