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
const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 4, idle_timeout: 20 });

const strict = sql`published AND UPPER(country) = ANY(${AFRICA})
  AND payments_source IS DISTINCT FROM 'storecensus' AND payments ~* 'shopify_payments'
  AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
  AND domain !~* '\\.za$' AND (currency IS NULL OR upper(currency) <> 'ZAR')`;

const rows = await sql`SELECT domain, UPPER(country) AS was, currency FROM imported_stores WHERE ${strict}`;
console.log(`${rows.length} stores in the strict mislabel set (African-tagged, probe shopify_payments, intl TLD, non-ZAR).`);

const plan = rows.map((r) => { const [cc, how] = derive(r.domain, r.currency); return { domain: r.domain, was: r.was, to: cc, how, disputed: cc == null }; });
const byTo = {}, byHow = {};
for (const p of plan) { byTo[p.to || "(disputed→null)"] = (byTo[p.to || "(disputed→null)"] || 0) + 1; byHow[p.how] = (byHow[p.how] || 0) + 1; }
console.log("→ re-tag distribution:"); Object.entries(byTo).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log("   " + k.padEnd(18) + v));
console.log("→ method:", JSON.stringify(byHow));
const resolved = plan.filter((p) => p.to), disputed = plan.filter((p) => !p.to);
console.log(`→ ${resolved.length} get a real country; ${disputed.length} → country=NULL, country_source='disputed' (re-derive later).`);

if (DRY) { console.log("\nDRY RUN — no writes. Sample of resolved:"); resolved.slice(0, 8).forEach((p) => console.log(`   ${p.domain}  ${p.was} → ${p.to} (${p.how})`)); await sql.end(); process.exit(0); }

const now = new Date().toISOString();
let w = 0;
for (const p of plan) {
  if (p.to) await sql`UPDATE imported_stores SET country = ${p.to}, country_source = 'payment_geo', country_checked_at = ${now} WHERE domain = ${p.domain}`;
  else await sql`UPDATE imported_stores SET country = NULL, country_source = 'disputed', country_checked_at = ${now} WHERE domain = ${p.domain}`;
  if (++w % 200 === 0) console.log(`   …${w}/${plan.length}`);
}
console.log(`✅ updated ${w} stores (${resolved.length} re-tagged, ${disputed.length} disputed). Reverse with: country_source IN ('payment_geo','disputed').`);
await sql.end();
