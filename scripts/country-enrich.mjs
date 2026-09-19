#!/usr/bin/env node
/**
 * Country enricher — attribute a store's country from its STOREFRONT, not its TLD. IP geo is
 * useless for Shopify (every store sits on Shopify's edge, 23.227.38.x), but Shopify injects the
 * shop's own country into the page JS as `Shopify.country`, and the active currency is a strong
 * secondary signal. So for domains with no country signal in the TLD (.com, .co, .io, .shop …) we
 * fetch the homepage and read the country straight out of it.
 *
 *   node --env-file=.env.local scripts/country-enrich.mjs [--limit 2000] [--concurrency 8] [--like '%.com'] [--dry-run]
 *
 * Writes country + country_source='storefront'; country_checked_at marks the attempt (network
 * failures stay null → retried). Only overwrites when we get an authoritative signal.
 */
import postgres from "postgres";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const LIMIT = parseInt(arg("--limit", "2000"), 10);
const CONC = parseInt(arg("--concurrency", "8"), 10);
const LIKE = arg("--like", "%.com");
const DRY = process.argv.includes("--dry-run");
const UA = "Mozilla/5.0 (compatible; terrain-radar/1.0; +country-attribution)";

// Unambiguous currency → country (local currencies pin a market; USD/EUR/etc. are skipped as global).
const CUR_COUNTRY = {
  ZAR: "ZA", NGN: "NG", KES: "KE", GHS: "GH", TZS: "TZ", UGX: "UG", EGP: "EG", MAD: "MA",
  RWF: "RW", ZMW: "ZM", BWP: "BW", MUR: "MU", XOF: "SN", DZD: "DZ", TND: "TN", ETB: "ET",
  JPY: "JP", GBP: "GB", AUD: "AU", CAD: "CA", INR: "IN", BRL: "BR", MXN: "MX", NZD: "NZ",
  SGD: "SG", HKD: "HK", TWD: "TW", KRW: "KR", THB: "TH", IDR: "ID", MYR: "MY", PHP: "PH",
  PKR: "PK", AED: "AE", SAR: "SA", ILS: "IL", TRY: "TR", PLN: "PL", SEK: "SE", NOK: "NO",
  DKK: "DK", CHF: "CH", CLP: "CL", COP: "CO", ARS: "AR", PEN: "PE",
};

const TIMEOUT = 12000;
async function get(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try { return await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": UA } }); }
  catch { return null; } finally { clearTimeout(t); }
}

/** Pull the best country signal from a storefront HTML: Shopify.country (authoritative), then
 *  JSON-LD addressCountry, then an unambiguous local currency. Returns {country, source} | null. */
function attribute(html) {
  const sc = html.match(/Shopify\.country\s*=\s*["']([A-Z]{2})["']/)?.[1]
    || html.match(/"country_code"\s*:\s*"([A-Z]{2})"/)?.[1];
  if (sc) return { country: sc.toUpperCase(), source: "shopify_country" };
  const ld = html.match(/"addressCountry"\s*:\s*\{?\s*"?(?:name"\s*:\s*")?([A-Z]{2})"/)?.[1];
  if (ld) return { country: ld.toUpperCase(), source: "jsonld" };
  const cur = (html.match(/Shopify\.currency\s*=\s*\{[^}]*?"active"\s*:\s*"([A-Z]{3})"/)?.[1]
    || html.match(/"currency"\s*:\s*"([A-Z]{3})"/)?.[1]
    || html.match(/data-currency="([A-Z]{3})"/)?.[1] || "").toUpperCase();
  if (cur && CUR_COUNTRY[cur]) return { country: CUR_COUNTRY[cur], source: `currency:${cur}` };
  return null;
}

async function probe(domain) {
  for (const u of [`https://${domain}/`, `https://www.${domain}/`]) {
    const r = await get(u);
    if (!r) return { net: true };
    if (!r.ok) continue;
    const html = await r.text().catch(() => "");
    if (!html) continue;
    return { hit: attribute(html) };
  }
  return { hit: null };
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: Math.min(CONC + 1, 6), idle_timeout: 20 });
  try {
    await sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS country_checked_at TIMESTAMPTZ`;
    await sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS country_source TEXT`;
    const rows = await sql`
      SELECT domain, country FROM imported_stores
      WHERE domain LIKE ${LIKE} AND country_checked_at IS NULL
        AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
      ORDER BY published DESC, discovered_at DESC NULLS LAST
      LIMIT ${LIMIT}`;
    console.log(`country-enrich: ${rows.length} '${LIKE}' stores (concurrency ${CONC})${DRY ? " [DRY RUN]" : ""}`);

    let i = 0, done = 0, attributed = 0, changed = 0, net = 0;
    const tally = new Map(), srcTally = new Map();
    async function worker() {
      while (i < rows.length) {
        const { domain, country } = rows[i++];
        const res = await probe(domain);
        done++;
        if (res.net) { net++; continue; }                 // leave country_checked_at null → retry
        if (res.hit) {
          attributed++;
          tally.set(res.hit.country, (tally.get(res.hit.country) ?? 0) + 1);
          srcTally.set(res.hit.source.split(":")[0], (srcTally.get(res.hit.source.split(":")[0]) ?? 0) + 1);
          const isChange = (country ?? "").toUpperCase() !== res.hit.country;
          if (isChange) changed++;
          if (!DRY) await sql`UPDATE imported_stores
            SET country = ${res.hit.country}, country_source = ${res.hit.source}, country_checked_at = now()
            WHERE domain = ${domain}`.catch(() => {});
        } else if (!DRY) {
          await sql`UPDATE imported_stores SET country_checked_at = now() WHERE domain = ${domain}`.catch(() => {});
        }
        if (done % 50 === 0) process.stdout.write(`\r  ${done}/${rows.length}  attributed ${attributed} (changed ${changed}), net-fail ${net}`);
      }
    }
    await Promise.all(Array.from({ length: CONC }, worker));
    console.log(`\ndone. ${attributed}/${rows.length} attributed (${changed} changed country), ${net} network-failed.`);
    console.log("by source:", [...srcTally.entries()].map(([k, n]) => `${k}=${n}`).join(", "));
    console.log("top countries:", [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${k}:${n}`).join(", "));
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
