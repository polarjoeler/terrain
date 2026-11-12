#!/usr/bin/env node
/**
 * Identity enricher — Shopify's own record of a store, from /meta.json, for the Shopify stores that
 * have no country. One small request per store (~1KB, against a 100-500KB homepage), so the whole
 * country-less backlog (~980k live stores on 2026-11-11) costs a few GB of proxy bandwidth, not the
 * plan's 250GB. It gives:
 *   · shop_country/city/province — Shopify's answer, which becomes `country` when we had none
 *     (country_source='shopify_meta');
 *   · shop_id (rises over time: a free "how new is it" signal), shop_currency, myshopify_domain.
 *
 *   node --env-file=.env.local scripts/identity-enrich.mjs [--limit 6000] [--concurrency 12] [--pace-ms 500] [--dry-run]
 *
 * Runs through the Webshare fleet (STORE_PROBE_PROXY_FILE) — never direct: direct, these requests
 * spend the home IP's Shopify budget. Tested 2026-11-11 on 100 country-less finds: 77 identified in
 * 51s at concurrency 12. A 429 is not an answer and is left for a later run; if over a quarter of the
 * last 200 answers are 429s the run stops. Newest finds first: on 2026-11-12 a 300-store dry run
 * identified 73% newest-first against 36% oldest-first, where frozen (402) and dead stores pile up.
 * Each answer stamps country_checked_at, so country-enrich's homepage fetch skips what this covered.
 */
import postgres from "postgres";
import { loadProxies, pickProxy, fetchText, closeAgents } from "./lib/proxy-fetch.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const LIMIT = parseInt(arg("--limit", "6000"), 10);
const CONC = parseInt(arg("--concurrency", "12"), 10);
const PACE_MS = parseInt(arg("--pace-ms", "500"), 10);
const DRY = process.argv.includes("--dry-run");
const BATCH = 200;
const STALE_DAYS = 3;   // unreachable this long after discovery → stamped, or it re-queues forever
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROXIES = loadProxies();
if (!PROXIES.length && !DRY) {
  console.error("identity-enrich: STORE_PROBE_PROXY_FILE is not set — refusing to spend the home IP's Shopify budget.");
  process.exit(2);
}

async function metaOnce(host) {
  const r = await fetchText(`https://${host}/meta.json`, { proxy: pickProxy(PROXIES), timeoutMs: 15000, maxBytes: 64_000, ua: UA });
  if (!r) return { miss: "unreachable", net: true };
  if (r.status === 429) return { miss: "blocked_429", throttled: true };
  if (r.status >= 500) return { miss: `http_${r.status}`, net: true };
  if (r.status !== 200) return { miss: `http_${r.status}` };
  if (!r.contentType.toLowerCase().includes("json")) return { miss: "html_at_meta" };   // not a Shopify storefront (any more)
  try {
    const d = JSON.parse(r.text);
    return d && typeof d === "object" && d.id ? { shop: d } : { miss: "json_no_id" };
  } catch { return { miss: "bad_json" }; }
}
// a www. host can hard-404 meta.json while the apex serves it
async function getMeta(domain) {
  const first = await metaOnce(domain);
  if (first.shop || first.throttled || !/^www\./i.test(domain)) return first;
  const apex = await metaOnce(domain.slice(4));
  return apex.shop ? apex : first;
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 2, idle_timeout: 20,
    connection: { statement_timeout: 120000, idle_in_transaction_session_timeout: 120000, lock_timeout: 5000 } });
  try {
    const cols = new Set((await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'imported_stores'
      AND column_name IN ('shop_id','shop_country','shop_city','shop_province','shop_currency','myshopify_domain','country_checked_at','country_source')`)
      .map((r) => r.column_name));
    if (cols.size < 8) { console.error("identity-enrich: identity columns missing — run sync-checkout-payments once first."); process.exit(1); }

    const rows = await sql`SELECT domain, discovered_at FROM imported_stores
      WHERE published AND lower(platform) = 'shopify' AND (country IS NULL OR country = '')
        AND shop_id IS NULL AND country_checked_at IS NULL AND country_source IS DISTINCT FROM 'manual'
        AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
      ORDER BY discovered_at DESC NULLS LAST LIMIT ${LIMIT}`;
    console.log(`identity-enrich: ${rows.length.toLocaleString()} country-less Shopify stores · concurrency ${CONC} · ${PROXIES.length} proxies${DRY ? " · DRY RUN" : ""}`);
    if (!rows.length) return;

    const found = [], stamp = [], misses = {}, countries = {};
    const recent = [];   // rolling window of the last 200 answers: true = 429
    let done = 0, throttled = 0, stop = false, i = 0;
    const staleBefore = Date.now() - STALE_DAYS * 864e5;

    const flush = async () => {
      if (DRY) { found.length = 0; stamp.length = 0; return; }
      if (found.length) {
        const vals = found.splice(0).map((f) => [f.domain, f.id, f.country, f.city, f.province, f.currency, f.myshopify]);
        await sql`UPDATE imported_stores s SET
            shop_id          = COALESCE(s.shop_id, v.id::bigint),
            shop_country     = COALESCE(v.country, s.shop_country),
            shop_city        = COALESCE(v.city, s.shop_city),
            shop_province    = COALESCE(v.province, s.shop_province),
            shop_currency    = COALESCE(v.currency, s.shop_currency),
            myshopify_domain = COALESCE(v.myshopify, s.myshopify_domain),
            country          = CASE WHEN COALESCE(s.country, '') = '' AND s.country_source IS DISTINCT FROM 'manual' AND v.country IS NOT NULL
                                    THEN v.country ELSE s.country END,
            country_source   = CASE WHEN COALESCE(s.country, '') = '' AND s.country_source IS DISTINCT FROM 'manual' AND v.country IS NOT NULL
                                    THEN 'shopify_meta' ELSE s.country_source END,
            country_checked_at = now()
          FROM (VALUES ${sql(vals)}) AS v(domain, id, country, city, province, currency, myshopify)
          WHERE s.domain = v.domain`.catch((e) => console.error("  write failed:", e.message));
      }
      if (stamp.length) {
        await sql`UPDATE imported_stores SET country_checked_at = now() WHERE domain = ANY(${stamp.splice(0)})`
          .catch((e) => console.error("  stamp failed:", e.message));
      }
    };

    await Promise.all(Array.from({ length: CONC }, async () => {
      while (!stop && i < rows.length) {
        const row = rows[i++];
        const r = await getMeta(row.domain);
        done++;
        recent.push(!!r.throttled); if (recent.length > 200) recent.shift();
        if (r.shop) {
          const m = r.shop, cc = m.country ? String(m.country).toUpperCase().slice(0, 2) : null;
          found.push({ domain: row.domain, id: Number(m.id) ? String(Number(m.id)) : null, country: cc, city: m.city || null,
            province: m.province || null, currency: m.currency || null, myshopify: m.myshopify_domain || null });
          if (cc) countries[cc] = (countries[cc] || 0) + 1;
        } else {
          misses[r.miss] = (misses[r.miss] || 0) + 1;
          if (r.throttled) throttled++;
          // a 429 says nothing about the store; a network miss gets more tries until it's stale
          else if (!r.net || (row.discovered_at && new Date(row.discovered_at).getTime() < staleBefore)) stamp.push(row.domain);
        }
        if (found.length + stamp.length >= BATCH) await flush();
        if (recent.length >= 200 && recent.filter(Boolean).length > 50) {
          if (!stop) console.log(`  stopping: over 25% of the last 200 answers were 429s (after ${done.toLocaleString()} stores)`);
          stop = true;
        }
        if (done % 1000 === 0) console.log(`  ${done.toLocaleString()} done · ${Object.values(countries).reduce((a, b) => a + b, 0).toLocaleString()} identified · ${throttled} throttled`);
        if (PACE_MS) await sleep(PACE_MS);
      }
    }));
    await flush();

    const ident = Object.values(countries).reduce((a, b) => a + b, 0);
    const af = ["ZA","KE","NG","GH","EG","MA","TZ","UG","RW","ZM","BW","MU","NA","ET","TN","DZ","SN","CI","CM","MZ","AO","ZW","MW","LS","SZ","LY","SO"];
    console.log(`identity-enrich done: ${done.toLocaleString()} checked · ${ident.toLocaleString()} got a country (${af.reduce((s, c) => s + (countries[c] || 0), 0)} African) · ${throttled} throttled`);
    console.log(`  top countries: ${Object.entries(countries).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([c, n]) => `${c} ${n}`).join(" · ")}`);
    if (Object.keys(misses).length) console.log(`  no answer: ${Object.entries(misses).map(([k, n]) => `${k} ${n}`).join(" · ")}`);
  } finally {
    await sql.end();
    closeAgents();
  }
}

main().catch((e) => { console.error(e); closeAgents(); process.exit(1); });
