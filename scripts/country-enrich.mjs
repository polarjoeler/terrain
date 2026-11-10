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
 *
 * Shopify custom domains all resolve to Shopify's edge, so run direct these GETs spend the residential
 * IP's ~1,200/day budget (never burst; see residential-ip-rate-budget). With STORE_PROBE_PROXY_FILE set
 * they rotate across the Webshare fleet instead. A 429 is not an answer: it is left unstamped and five
 * in a row end the run. With --null-country the budget goes to stores with a free African signal first
 * (DNS host / domain name on the newest finds, then CrUX rank in ZA/KE/NG), then the newest finds.
 */
import postgres from "postgres";
import { Resolver } from "node:dns/promises";
import { ensureColumns } from "./lib/ensure-schema.mjs";
import { loadProxies, pickProxy, fetchText, closeAgents } from "./lib/proxy-fetch.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const LIMIT = parseInt(arg("--limit", "2000"), 10);
const CONC = parseInt(arg("--concurrency", "8"), 10);
const LIKE = arg("--like", "%.com");
// --null-country targets stores with NO country yet (the newly-banked global generic-TLD stores)
// instead of a domain pattern — the mode the recurring job uses.
const NULL_COUNTRY = process.argv.includes("--null-country");
const DRY = process.argv.includes("--dry-run");
const PACE_MS = parseInt(arg("--pace-ms", "0"), 10);
const MAX_429_STREAK = 5;
const STALE_MS = 3 * 864e5;   // a store still unreachable after 3 days is stamped, or it re-queues forever
const CRUX_MARKETS = ["ZA", "KE", "NG"];
const NEW_WINDOW = "3 hours 30 minutes";   // one cron interval + slack
// Measured on labelled generic-TLD stores (2026-11-09): these hit 2.8% of ZA/KE/NG, 0.04% of others.
const AF_NS = /(host-h\.net|dns-h\.com|\.co\.za\.?$|otherdns\.|afrihost|xneelo|hetzner\.co\.za|webafrica|\.ng\.?$|\.ke\.?$|whogohost|qservers|truehost|hostpinnacle|konsoleh|domains\.co\.za)/i;
const AF_MX = /(\.co\.za\.?$|\.ng\.?$|\.ke\.?$|afrihost|xneelo|host-h\.net|konsoleh)/i;
const AF_NAME = /(southafrica|mzansi|joburg|johannesburg|capetown|cape-town|durban|pretoria|sandton|stellenbosch|africa|afri|kasi|braai|biltong|naija|lagos|abuja|nigeria|9ja|nairobi|kenya|mombasa|zulu|xhosa|ubuntu)/i;
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
const PROXIES = loadProxies();   // empty when STORE_PROBE_PROXY_FILE is unset → direct
async function get(url) {
  if (PROXIES.length) {
    const r = await fetchText(url, { proxy: pickProxy(PROXIES), timeoutMs: TIMEOUT, ua: UA });
    return r && { status: r.status, ok: r.status >= 200 && r.status < 300, text: async () => r.text };
  }
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

/** Shopify's numeric shop id, in every storefront's analytics snippet. Ids rise over time, so a high one
 *  marks a recently created shop (measured against earliest-product dates, 2026-11-09). */
const shopIdOf = (html) => html.match(/__st\s*=\s*\{[^}]*?"a"\s*:\s*(\d+)/)?.[1] ?? html.match(/"shopId"\s*:\s*"?(\d+)/)?.[1] ?? null;

async function probe(domain) {
  const apex = domain.replace(/^www\./, "");
  let net = false;
  for (const u of [`https://${domain}/`, domain === apex ? `https://www.${domain}/` : `https://${apex}/`]) {
    const r = await get(u);
    if (!r) { net = true; continue; }
    if (r.status === 429) return { throttled: true };
    if (r.status >= 500) return { net: true };
    if (!r.ok) continue;
    const html = await r.text().catch(() => "");
    if (!html) continue;
    return { hit: attribute(html), shopId: shopIdOf(html) };
  }
  return net ? { net: true } : { hit: null };
}

/** Newest finds with a free African signal: domain name, then NS/MX host (DNS is exempt from the IP budget). */
async function hintedNewStores(sql, base) {
  const fresh = await sql`SELECT domain, country, discovered_at FROM imported_stores
    WHERE ${base} AND created_at > now() - ${NEW_WINDOW}::interval LIMIT 40000`.catch(() => []);
  const res = new Resolver({ timeout: 3000, tries: 1 });
  res.setServers(["1.1.1.1", "8.8.8.8"]);
  const named = fresh.filter((r) => AF_NAME.test(r.domain));
  const rest = fresh.filter((r) => !AF_NAME.test(r.domain));
  const hosted = [];
  let i = 0;
  await Promise.all(Array.from({ length: 60 }, async () => {
    while (i < rest.length) {
      const r = rest[i++];
      const apex = r.domain.replace(/^www\./, "");
      const ns = await res.resolveNs(apex).catch(() => []);
      const mx = ns.some((h) => AF_NS.test(h)) ? [] : await res.resolveMx(apex).catch(() => []);
      if (ns.some((h) => AF_NS.test(h)) || mx.some((m) => AF_MX.test(m.exchange))) hosted.push(r);
    }
  }));
  console.log(`hints: ${fresh.length} new stores → ${named.length} by name, ${hosted.length} by DNS host`);
  return [...named, ...hosted];
}

/** Country-null stores that rank in a focus market's CrUX list, busiest first. */
async function cruxStores(sql, base, limit) {
  if (limit <= 0) return [];
  const rows = await sql`
    SELECT s.domain, s.country, s.discovered_at
    FROM (SELECT domain, min(rank) r FROM crux_ranks WHERE cc = ANY(${CRUX_MARKETS}) GROUP BY domain) c
    JOIN imported_stores s ON s.domain IN (c.domain, 'www.' || c.domain)
    WHERE ${base} ORDER BY c.r LIMIT ${limit}`.catch((e) => { console.error("crux queue failed:", e.message); return []; });
  console.log(`crux: ${rows.length} stores queued`);
  return rows;
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: Math.min(CONC + 1, 6), idle_timeout: 20,
    connection: { statement_timeout: 120000, idle_in_transaction_session_timeout: 120000, lock_timeout: 5000 } });
  try {
    await ensureColumns(sql, "imported_stores",
      { country_checked_at: "TIMESTAMPTZ", country_source: "TEXT" });
    const target = NULL_COUNTRY ? sql`(country IS NULL OR country = '')` : sql`domain LIKE ${LIKE}`;
    const base = sql`${target} AND country_checked_at IS NULL
        AND country_source IS DISTINCT FROM 'manual'
        AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))`;
    let rows;
    if (NULL_COUNTRY) {
      const hinted = (await hintedNewStores(sql, base)).slice(0, LIMIT);
      const crux = await cruxStores(sql, base, LIMIT - hinted.length);
      const room = LIMIT - hinted.length - crux.length;
      const newest = room > 0 ? await sql`SELECT domain, country, discovered_at FROM imported_stores WHERE ${base}
        ORDER BY discovered_at DESC NULLS LAST LIMIT ${room}` : [];
      const seen = new Set();
      rows = [...hinted, ...crux, ...newest].filter((r) => !seen.has(r.domain) && seen.add(r.domain));
    } else {
      rows = await sql`SELECT domain, country, discovered_at FROM imported_stores WHERE ${base}
        ORDER BY published DESC, discovered_at DESC NULLS LAST LIMIT ${LIMIT}`;
    }
    console.log(`country-enrich: ${rows.length} ${NULL_COUNTRY ? "country-null" : `'${LIKE}'`} stores (concurrency ${CONC})${DRY ? " [DRY RUN]" : ""}`);

    let i = 0, done = 0, attributed = 0, changed = 0, net = 0, throttled = 0, streak = 0, stopped = false;
    const tally = new Map(), srcTally = new Map();
    async function worker() {
      while (i < rows.length && !stopped) {
        if (PACE_MS && i) await new Promise((r) => setTimeout(r, PACE_MS));
        if (i >= rows.length || stopped) break;   // another worker took the last row during the pause
        const { domain, country, discovered_at } = rows[i++];
        const res = await probe(domain);
        done++;
        if (res.throttled) {                              // not an answer — leave it queued
          throttled++;
          if (++streak >= MAX_429_STREAK) { stopped = true; console.log(`\n  ${streak} straight 429s — stopping so the next run starts clean.`); }
          continue;
        }
        streak = 0;
        if (res.net) {                                    // leave country_checked_at null → retry, until stale
          net++;
          if (!DRY && (!discovered_at || Date.now() - new Date(discovered_at).getTime() > STALE_MS)) {
            await sql`UPDATE imported_stores SET country_checked_at = now() WHERE domain = ${domain}`.catch(() => {});
          }
          continue;
        }
        if (res.hit) {
          attributed++;
          tally.set(res.hit.country, (tally.get(res.hit.country) ?? 0) + 1);
          srcTally.set(res.hit.source.split(":")[0], (srcTally.get(res.hit.source.split(":")[0]) ?? 0) + 1);
          const isChange = (country ?? "").toUpperCase() !== res.hit.country;
          if (isChange) changed++;
          if (!DRY) await sql`UPDATE imported_stores
            SET country = ${res.hit.country}, country_source = ${res.hit.source}, country_checked_at = now(),
                shop_id = COALESCE(shop_id, ${res.shopId ?? null}::bigint)
            WHERE domain = ${domain}`.catch(() => {});
        } else if (!DRY) {
          await sql`UPDATE imported_stores SET country_checked_at = now(), shop_id = COALESCE(shop_id, ${res.shopId ?? null}::bigint)
            WHERE domain = ${domain}`.catch(() => {});
        }
        if (done % 50 === 0) process.stdout.write(`\r  ${done}/${rows.length}  attributed ${attributed} (changed ${changed}), net-fail ${net}`);
      }
    }
    await Promise.all(Array.from({ length: CONC }, worker));
    console.log(`\ndone. ${attributed}/${rows.length} attributed (${changed} changed country), ${net} network-failed, ${throttled} throttled.`);
    console.log("by source:", [...srcTally.entries()].map(([k, n]) => `${k}=${n}`).join(", "));
    console.log("top countries:", [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${k}:${n}`).join(", "));
  } finally { closeAgents(); await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
