/**
 * Re-tag Shopify stores that are labelled to an African country but are demonstrably NOT African:
 * probe-verified `shopify_payments` (which can't run in Africa) + an international TLD + a non-ZAR
 * currency. Shopify Payments availability is the oracle; TLD + currency corroborate and, critically,
 * keep us OFF real SA stores (any `.za` TLD or ZAR currency is EXCLUDED — verified false-positive:
 * extremeairsoftsa.co.za carries shopify_payments as a probe artifact but is genuinely SA).
 *
 * Country is derived from ccTLD, else single-country currency, else USD→US. EUR (ambiguous which EU
 * country) and no-signal rows can't be pinned from data alone → marked country_source='disputed' and
 * country=NULL so they drop out of Africa without being given a wrong new country (re-derive later
 * with a geo-probe). Everything is stamped in country_source, so the whole pass is reversible/auditable.
 *
 * PERF (2026-09): the old single `UPPER(country)=ANY(AFRICA) AND payments ~* …` scan seq-scanned all
 * ~500k rows and hit the DB statement_timeout, so the pass silently never completed (leaving ~1.5k
 * mislabelled ZA Shopify-Payments stores on the books). Now it loops PER COUNTRY (each scan is small
 * and index-friendly) and writes SET-BASED — one UPDATE per (target country) via domain = ANY(...),
 * not a round-trip per row.
 *
 *   node --env-file=.env.local scripts/retag-mislabeled-country.mjs --dry
 *   node --env-file=.env.local scripts/retag-mislabeled-country.mjs        # writes
 */
import postgres from "postgres";

const AFRICA = ["DZ","AO","BJ","BW","BF","BI","CM","CV","CF","TD","KM","CG","CD","CI","DJ","EG","GQ","ER","SZ","ET","GA","GM","GH","GN","GW","KE","LS","LR","LY","MG","MW","ML","MR","MU","MA","MZ","NA","NE","NG","RW","ST","SN","SC","SL","SO","ZA","SS","SD","TZ","TG","TN","UG","EH","ZM","ZW"];
const CCTLD = [[/\.co\.uk$|\.uk$/,"GB"],[/\.de$/,"DE"],[/\.fr$/,"FR"],[/\.it$/,"IT"],[/\.es$/,"ES"],[/\.nl$/,"NL"],[/\.ie$/,"IE"],[/\.com\.au$|\.au$/,"AU"],[/\.ca$/,"CA"],[/\.ch$/,"CH"],[/\.se$/,"SE"],[/\.dk$/,"DK"],[/\.no$/,"NO"],[/\.fi$/,"FI"],[/\.pt$/,"PT"],[/\.be$/,"BE"],[/\.at$/,"AT"],[/\.pl$/,"PL"],[/\.cz$/,"CZ"],[/\.co\.nz$|\.nz$/,"NZ"],[/\.com\.sg$|\.sg$/,"SG"],[/\.co\.jp$|\.jp$/,"JP"]];
const CCY = { GBP:"GB", AUD:"AU", CAD:"CA", CHF:"CH", SEK:"SE", DKK:"DK", NOK:"NO", PLN:"PL", CZK:"CZ", JPY:"JP", SGD:"SG", HKD:"HK", NZD:"NZ", USD:"US" };
const derive = (domain, cur) => {
  for (const [re, cc] of CCTLD) if (re.test(domain)) return [cc, "tld"];
  const c = (cur || "").toUpperCase();
  if (CCY[c]) return [CCY[c], "currency"];
  if (c === "EUR") return [null, "eur-ambiguous"];
  return [null, "no-signal"];
};

const DRY = process.argv.includes("--dry");
// Bump the statement timeout for this maintenance pass — the per-country scans are cheap but the
// pooler can be slow; we never want a stall to leave the retag half-done.
const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 4, idle_timeout: 20, connection: { statement_timeout: 120000 } });

// Per-country so each scan uses the country filter (index-friendly) instead of one all-Africa
// seq-scan. Guard is identical to before: probe-verified shopify_payments, intl TLD, non-ZAR.
const plan = [];
for (const cc of AFRICA) {
  const rows = await sql`
    SELECT domain, UPPER(country) AS was, currency FROM imported_stores
    WHERE published AND UPPER(country) = ${cc}
      AND payments_source IS DISTINCT FROM 'storecensus' AND lower(payments) LIKE '%shopify_payments%'
      AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
      AND domain NOT LIKE '%.za' AND (currency IS NULL OR upper(currency) <> 'ZAR')`.catch((e) => {
    console.error(`  ${cc}: read failed (${e.message}) — skipping`); return [];
  });
  for (const r of rows) { const [to, how] = derive(r.domain, r.currency); plan.push({ domain: r.domain, was: r.was, to, how }); }
}

console.log(`${plan.length} stores in the strict mislabel set (African-tagged, probe shopify_payments, intl TLD, non-ZAR).`);
const byTo = {}, byHow = {}, byWas = {};
for (const p of plan) { byTo[p.to || "(disputed→null)"] = (byTo[p.to || "(disputed→null)"] || 0) + 1; byHow[p.how] = (byHow[p.how] || 0) + 1; byWas[p.was] = (byWas[p.was] || 0) + 1; }
console.log("→ from (was):"); Object.entries(byWas).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log("   " + k.padEnd(6) + v));
console.log("→ re-tag distribution:"); Object.entries(byTo).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log("   " + k.padEnd(18) + v));
console.log("→ method:", JSON.stringify(byHow));
const resolved = plan.filter((p) => p.to), disputed = plan.filter((p) => !p.to);
console.log(`→ ${resolved.length} get a real country; ${disputed.length} → country=NULL, country_source='disputed' (re-derive later).`);

if (DRY) { console.log("\nDRY RUN — no writes. Sample of resolved:"); resolved.slice(0, 8).forEach((p) => console.log(`   ${p.domain}  ${p.was} → ${p.to} (${p.how})`)); await sql.end(); process.exit(0); }

// SET-BASED writes: group domains by target country → one UPDATE each (plus one for disputed),
// instead of a round-trip per store.
const now = new Date().toISOString();
const groups = new Map();               // target cc → [domains]
for (const p of resolved) { if (!groups.has(p.to)) groups.set(p.to, []); groups.get(p.to).push(p.domain); }
let w = 0;
for (const [to, domains] of groups) {
  const r = await sql`UPDATE imported_stores SET country = ${to}, country_source = 'payment_geo', country_checked_at = ${now}
    WHERE domain = ANY(${domains}) RETURNING 1`;
  w += r.length; console.log(`   ${to}: ${r.length}`);
}
if (disputed.length) {
  const r = await sql`UPDATE imported_stores SET country = NULL, country_source = 'disputed', country_checked_at = ${now}
    WHERE domain = ANY(${disputed.map((p) => p.domain)}) RETURNING 1`;
  w += r.length; console.log(`   (disputed→null): ${r.length}`);
}
console.log(`✅ updated ${w} stores (${resolved.length} re-tagged, ${disputed.length} disputed). Reverse with: country_source IN ('payment_geo','disputed').`);
await sql.end();
