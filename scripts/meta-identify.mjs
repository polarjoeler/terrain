#!/usr/bin/env node
/**
 * meta-identify — give country-less Shopify stores Shopify's OWN country, one /meta.json each.
 *
 * Why this lane: ~1.29M published Shopify stores have no country (2026-11-13), 99% of them fresh
 * ct_tail .com finds with no free signal at all (no currency, language or CrUX rank, generic TLD).
 * Only a fetch can place them, and /meta.json is the cheapest fetch there is: one small JSON
 * response carrying country/city/province/currency/shop_id/myshopify_domain. Measured 2026-11-11:
 * 77/100 country-less finds identified via the Webshare pool, 0 throttled. The answer is Shopify's
 * registered shop address, and it does NOT follow the visitor IP (25/25 matched direct from Rex),
 * so proxies don't contaminate labels.
 *
 *   STORE_PROBE_PROXY_FILE=~/shopify-radar/proxies.txt \
 *   node --env-file=.env.local scripts/meta-identify.mjs [--limit 12000] [--concurrency 24] [--dry-run]
 *
 * Without the proxy file it REFUSES to run (it would burn the home IP's ~1,200/day budget in
 * minutes — see residential-ip-rate-budget). Pass --direct to override for a tiny test.
 *
 * Queue (all on idx_is_live_universe, no full scan): CrUX-ranked first, then live_status='active',
 * then never-liveness-checked. A store leaves the queue when it gets a country, or when it is
 * stamped country_checked_at with country_source='meta_miss:<reason>' (reversible as a set:
 * `UPDATE ... SET country_checked_at=NULL, country_source=NULL WHERE country_source LIKE 'meta_miss:%'`).
 * A 429 is not an answer — it stays queued, and a throttle streak ends the run.
 *
 * Writes: country (GB→UK, the project's canonical code), country_source='shop_meta',
 * country_checked_at, and the shop_* identity columns with COALESCE so existing values win.
 * Grouped UPDATE ... FROM unnest() every FLUSH rows — never row-by-row.
 */
import postgres from "postgres";
import { loadProxies, pickProxy, fetchText, closeAgents } from "./lib/proxy-fetch.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const LIMIT = parseInt(arg("--limit", "12000"), 10);
const CONC = parseInt(arg("--concurrency", "24"), 10);
const DRY = process.argv.includes("--dry-run");
const DIRECT = process.argv.includes("--direct");
const FLUSH = 250;
const MAX_429_STREAK = 25;          // across all workers; at conc 24 a handful of 429s is noise
const MAX_429_RATE = 0.2;           // …but a sustained 20% means the pool is being clamped
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const ALIAS = { GB: "UK" };         // lib/countries.ts uses UK; GB rows fall into region "Other"

const PROXIES = loadProxies();
if (!PROXIES.length && !DIRECT) {
  console.error("meta-identify: STORE_PROBE_PROXY_FILE unset/empty — refusing to spend the home IP. Use --direct for a tiny test.");
  process.exit(2);
}

async function metaOnce(host) {
  const r = await fetchText(`https://${host}/meta.json`, {
    proxy: pickProxy(PROXIES), timeoutMs: 10_000, maxBytes: 64_000, ua: UA, redirects: 3,
  });
  if (!r) return { miss: "unreachable", transient: true };
  if (r.status === 429) return { miss: "blocked_429", throttled: true };
  if (r.status === 402) return { miss: "frozen_402" };          // merchant stopped paying
  if (r.status === 403) return { miss: "blocked_403" };
  if (r.status >= 500) return { miss: `http_${r.status}`, transient: true };
  if (r.status !== 200) return { miss: `http_${r.status}` };
  if (!r.contentType.toLowerCase().includes("json")) return { miss: "html_at_meta" }; // off Shopify
  try {
    const d = JSON.parse(r.text);
    return d && typeof d === "object" && d.id ? { shop: d } : { miss: "json_no_id" };
  } catch { return { miss: "bad_json" }; }
}

// www. can hard-404 meta.json while the apex serves it; a transient failure gets one more try on
// a different proxy (pickProxy is random) before it counts.
async function getMeta(domain) {
  let r = await metaOnce(domain);
  if (r.transient) r = await metaOnce(domain);
  if (r.shop || r.throttled || !/^www\./i.test(domain)) return r;
  const apex = await metaOnce(domain.slice(4));
  return apex.shop ? apex : r;
}

const norm = (c) => {
  if (!c || typeof c !== "string" || !/^[A-Za-z]{2}$/.test(c)) return null;
  const u = c.toUpperCase();
  return ALIAS[u] ?? u;
};

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 2, idle_timeout: 20,
    connection: { statement_timeout: 120000, idle_in_transaction_session_timeout: 120000, lock_timeout: 5000 } });
  const base = sql`published AND country IS NULL AND platform = 'Shopify'
    AND country_checked_at IS NULL AND country_source IS DISTINCT FROM 'manual'`;
  try {
    // Tier 0 — free: rows whose identity was already fetched (checkout probe / backfill) but whose
    // country was never copied across. No request needed.
    const fromExisting = DRY
      ? (await sql`SELECT count(*)::int n FROM imported_stores WHERE published AND country IS NULL
          AND platform = 'Shopify' AND shop_country ~ '^[A-Za-z]{2}$' AND country_source IS DISTINCT FROM 'manual'`)[0].n
      : (await sql`UPDATE imported_stores SET
            country = CASE upper(shop_country) WHEN 'GB' THEN 'UK' ELSE upper(shop_country) END,
            country_source = 'shop_meta', country_checked_at = now()
          WHERE published AND country IS NULL AND platform = 'Shopify'
            AND shop_country ~ '^[A-Za-z]{2}$' AND country_source IS DISTINCT FROM 'manual'`).count;
    console.log(`tier 0: ${fromExisting} store(s) ${DRY ? "would be" : ""} placed from an existing shop_country`);

    const crux = await sql`SELECT domain FROM imported_stores WHERE ${base} AND crux_rank IS NOT NULL
      ORDER BY crux_rank LIMIT ${LIMIT}`;
    const active = crux.length < LIMIT ? await sql`SELECT domain FROM imported_stores WHERE ${base}
      AND live_status = 'active' AND crux_rank IS NULL LIMIT ${LIMIT - crux.length}` : [];
    const rest = crux.length + active.length < LIMIT ? await sql`SELECT domain FROM imported_stores WHERE ${base}
      AND live_status IS NULL LIMIT ${LIMIT - crux.length - active.length}` : [];
    const rows = [...crux, ...active, ...rest].map((r) => r.domain);
    console.log(`queue: ${rows.length} (crux ${crux.length}, active ${active.length}, unchecked ${rest.length}), `
      + `concurrency ${CONC}, ${PROXIES.length ? `${PROXIES.length} proxies` : "DIRECT"}${DRY ? " [DRY RUN]" : ""}`);

    let i = 0, done = 0, hit = 0, throttled = 0, streak = 0, stopped = false;
    const misses = {}, tally = {};
    let hits = [], stamps = [];
    const t0 = Date.now();

    async function flush() {
      const h = hits, s = stamps; hits = []; stamps = [];
      if (DRY) return;
      if (h.length) await sql`
        UPDATE imported_stores t SET
          country = v.country, country_source = 'shop_meta', country_checked_at = now(),
          shop_id = COALESCE(t.shop_id, v.shop_id),
          shop_country = COALESCE(t.shop_country, v.shop_country),
          shop_city = COALESCE(t.shop_city, v.city),
          shop_province = COALESCE(t.shop_province, v.province),
          shop_currency = COALESCE(t.shop_currency, v.currency),
          myshopify_domain = COALESCE(t.myshopify_domain, v.myshop)
        FROM (SELECT * FROM unnest(
          ${h.map((x) => x.domain)}::text[], ${h.map((x) => x.country)}::text[], ${h.map((x) => x.shop_id)}::bigint[],
          ${h.map((x) => x.shop_country)}::text[], ${h.map((x) => x.city)}::text[], ${h.map((x) => x.province)}::text[],
          ${h.map((x) => x.currency)}::text[], ${h.map((x) => x.myshop)}::text[])
          AS u(domain, country, shop_id, shop_country, city, province, currency, myshop)) v
        WHERE t.domain = v.domain AND t.country IS NULL AND t.country_source IS DISTINCT FROM 'manual'`;
      if (s.length) await sql`
        UPDATE imported_stores t SET country_checked_at = now(), country_source = v.src
        FROM (SELECT * FROM unnest(${s.map((x) => x.domain)}::text[], ${s.map((x) => x.src)}::text[]) AS u(domain, src)) v
        WHERE t.domain = v.domain AND t.country IS NULL AND t.country_source IS DISTINCT FROM 'manual'`;
    }

    async function worker() {
      while (!stopped && i < rows.length) {
        const domain = rows[i++];
        const r = await getMeta(domain);
        done++;
        if (r.throttled) {
          throttled++;
          if (++streak >= MAX_429_STREAK) { stopped = true; console.log(`\n  ${streak} straight 429s — stopping.`); }
          if (done >= 200 && throttled / done > MAX_429_RATE) { stopped = true; console.log(`\n  429 rate ${(100 * throttled / done).toFixed(1)}% — stopping.`); }
          continue;
        }
        streak = 0;
        const c = r.shop && norm(r.shop.country);
        if (c) {
          hit++;
          tally[c] = (tally[c] ?? 0) + 1;
          const m = r.shop;
          hits.push({ domain, country: c, shop_id: Number(m.id) || null, shop_country: m.country || null,
            city: m.city || null, province: m.province || null, currency: m.currency || null,
            myshop: m.myshopify_domain || null });
        } else {
          const why = r.shop ? "no_country" : r.miss;
          misses[why] = (misses[why] ?? 0) + 1;
          stamps.push({ domain, src: `meta_miss:${why}` });
        }
        if (hits.length + stamps.length >= FLUSH) await flush();
        if (done % 500 === 0) {
          const rate = done / ((Date.now() - t0) / 1000);
          process.stdout.write(`  ${done}/${rows.length}  placed ${hit} (${(100 * hit / done).toFixed(0)}%)  429 ${throttled}  ${rate.toFixed(1)}/s\n`);
        }
      }
    }
    await Promise.all(Array.from({ length: CONC }, worker));
    await flush();

    const secs = (Date.now() - t0) / 1000;
    console.log(`\ndone in ${Math.round(secs)}s (${(done / secs).toFixed(1)}/s). placed ${hit}/${done}, throttled ${throttled}.`);
    console.log("top countries:", Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, n]) => `${k}:${n}`).join(" "));
    console.log("no answer:", Object.entries(misses).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join(" ") || "none");
  } finally { closeAgents(); await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
