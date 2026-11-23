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
 * then never-liveness-checked. A store is queued while country_source IS NULL, and leaves when
 * it gets a country or is stamped country_source='meta_miss:<reason>' (reversible as a set:
 * `UPDATE ... SET country_checked_at=NULL, country_source=NULL WHERE country_source LIKE 'meta_miss:%'`).
 * A 429 is not an answer — it stays queued, and a throttle streak ends the run.
 *
 * "Unreachable" (no response after an in-run retry, or a 5xx) is NOT final on its own — verified
 * 2026-11-14, 3/25 answered on a later re-fetch. It is split by a DNS lookup:
 *   · NXDOMAIN / no A record      → meta_miss:dns_gone        (final)
 *   · resolves off Shopify's /24  → meta_miss:dns_off_shopify (final)
 *   · still on Shopify            → meta_retry:<n>, retried after RETRY_AFTER, up to MAX_ATTEMPTS,
 *                                   then meta_miss:unreachable.
 * The retry tier can't use an index (no schema change), so it only runs every RETRY_EVERY_H hours
 * (or with --retry-now). --requeue-unreachable converts pre-fix meta_miss:unreachable rows once.
 *
 * LIVENESS — a miss is also a liveness observation, applied with verify-liveness's own rules
 * (nextStatus): 402 frozen / 423 locked → live_status 'dead' on first sight; 404/410/DNS-gone →
 * live_miss+1, 'dead' once it reaches DEAD_AFTER (2) consecutive misses. The second observation
 * comes from the retry tier, which re-fetches gone rows at live_miss=1 a day later. Reachable but
 * not Shopify (html_at_meta / dns_off_shopify) is NOT churned — same guard as verify-liveness.
 * Every flip gets a churn_log row through scripts/lib/churn.mjs, the one writer shared with
 * verify-liveness and focus-liveness (historic = never verified live, so it stays out of period
 * churn). live_miss is shared too, so the three lanes' misses confirm each other. --backfill-liveness applies this to misses stamped before it
 * existed, with no fetching. Undo: live_status back to NULL/active where country_source LIKE
 * 'meta_miss:%' AND live_status='dead', plus the matching churn_log rows.
 *
 * Writes: country (GB→UK, the project's canonical code), country_source='shop_meta',
 * country_checked_at, and the shop_* identity columns with COALESCE so existing values win.
 * Grouped UPDATE ... FROM unnest() every FLUSH rows — never row-by-row.
 */
import postgres from "postgres";
import { Resolver } from "node:dns/promises";
import { loadProxies, pickProxy, fetchText, closeAgents } from "./lib/proxy-fetch.mjs";
import { logChurn } from "./lib/churn.mjs";

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
const MAX_ATTEMPTS = 3;             // runs that may see a Shopify-hosted store silent before it's final
const RETRY_AFTER = "1 day";
const RETRY_EVERY_H = 6;            // the retry query has no index; keep it to 4 runs a day
const RETRY_LIMIT = parseInt(arg("--retry-limit", "3000"), 10);
const RETRY_NOW = process.argv.includes("--retry-now");
const REQUEUE = process.argv.includes("--requeue-unreachable");
const BACKFILL = process.argv.includes("--backfill-liveness");
const DEAD_AFTER = 2;                                         // = verify-liveness.mjs DEAD_AFTER
const DEAD_NOW = new Set(["frozen_402", "http_423"]);         // Shopify suspended/locked: first sight
const GONE = new Set(["http_404", "http_410", "dns_gone"]);   // 2-miss protected
const GONE_SRC = [...GONE].map((g) => `meta_miss:${g}`);
const LIVE_SRC = [...DEAD_NOW, ...GONE].map((g) => `meta_miss:${g}`);

const resolver = new Resolver({ timeout: 4000, tries: 2 });
resolver.setServers(["1.1.1.1", "8.8.8.8"]);
// DNS is exempt from the Shopify-edge rate budget, so this costs nothing against the pool.
async function dnsClass(domain) {
  try {
    const ips = await resolver.resolve4(domain);
    if (!ips.length) return "gone";
    return ips.some((ip) => ip.startsWith("23.227.38.")) ? "shopify" : "off_shopify";
  } catch (e) {
    if (e.code === "ENOTFOUND" || e.code === "ENODATA") return "gone";
    return "unknown";               // resolver timeout etc. — not evidence either way, so retry
  }
}

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
  // "Not yet asked /meta.json" = no country_source. NOT country_checked_at IS NULL: country-enrich
  // stamps country_checked_at when its storefront read finds nothing and leaves country_source NULL,
  // so gating on the timestamp hid 146k stores from this lane (found 2026-11-23). Every outcome this
  // lane writes sets country_source (shop_meta / meta_miss:* / meta_retry:*), and 'manual' /
  // 'disputed' are set by people or the retag script, so a NULL source is exactly "never tried".
  const base = sql`published AND country IS NULL AND platform = 'Shopify'
    AND country_source IS NULL`;
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

    // A miss as a liveness observation — verify-liveness's nextStatus rules, applied in bulk.
    // `entries` = [{domain, src}]. Returns how many stores flipped to dead.
    async function applyLiveness(entries) {
      const why = (e) => e.src.split(":")[1];
      const deadNow = entries.filter((e) => DEAD_NOW.has(why(e))).map((e) => e.domain);
      const gone = entries.filter((e) => GONE.has(why(e))).map((e) => e.domain);
      const flipped = [];
      if (deadNow.length) {
        const r = await sql`UPDATE imported_stores SET live_status = 'dead',
            live_miss = COALESCE(live_miss, 0) + 1, live_checked_at = now()
          WHERE domain = ANY(${deadNow}) AND live_status IS DISTINCT FROM 'dead'
            AND live_status IS DISTINCT FROM 'migrated'
          RETURNING domain`;
        flipped.push(...r.map((x) => x.domain));
      }
      if (gone.length) {
        const r = await sql`UPDATE imported_stores SET
            live_miss = COALESCE(live_miss, 0) + 1, live_checked_at = now(),
            live_status = CASE WHEN COALESCE(live_miss, 0) + 1 >= ${DEAD_AFTER} THEN 'dead' ELSE live_status END
          WHERE domain = ANY(${gone}) AND live_status IS DISTINCT FROM 'dead'
            AND live_status IS DISTINCT FROM 'migrated'
          RETURNING domain, live_status`;
        flipped.push(...r.filter((x) => x.live_status === "dead").map((x) => x.domain));
      }
      // Same snapshot verify-liveness writes, and now literally the same statement:
      // scripts/lib/churn.mjs, shared by this lane, verify-liveness and focus-liveness. Still one
      // bulk INSERT for the whole flush. historic = never verified live → out of period churn.
      await logChurn(sql, flipped, "dead");
      return flipped.length;
    }

    // One-off: misses stamped before the liveness step existed get their first observation now.
    // No fetching — the observation already happened when they were stamped. Rows with live_miss
    // already >= 1 are skipped so a re-run can't count the same observation twice.
    if (BACKFILL) {
      const rows = await sql`SELECT domain, country_source AS src FROM imported_stores
        WHERE published AND platform = 'Shopify' AND country_source = ANY(${LIVE_SRC})
          AND COALESCE(live_miss, 0) = 0
          AND live_status IS DISTINCT FROM 'dead' AND live_status IS DISTINCT FROM 'migrated'
        ${process.argv.includes("--limit") ? sql`LIMIT ${LIMIT}` : sql``}`;
      const by = {};
      for (const r of rows) by[r.src] = (by[r.src] ?? 0) + 1;
      console.log(`backfill-liveness: ${rows.length} row(s)`, by, DRY ? "[DRY RUN]" : "");
      if (!DRY) {
        let dead = 0;
        for (let k = 0; k < rows.length; k += 2000) {
          dead += await applyLiveness(rows.slice(k, k + 2000));
          if ((k / 2000) % 10 === 0) console.log(`  ${Math.min(k + 2000, rows.length)}/${rows.length}  dead so far ${dead}`);
        }
        console.log(`backfill-liveness done: ${dead} flipped to dead (gone rows now at live_miss=1 await a 2nd look).`);
      }
      return;
    }

    // One-off: rows stamped meta_miss:unreachable before the DNS split get one more look as attempt 1.
    if (REQUEUE && !DRY) {
      const n = (await sql`UPDATE imported_stores SET country_source = 'meta_retry:1'
        WHERE published AND country IS NULL AND platform = 'Shopify'
          AND country_source = 'meta_miss:unreachable'`).count;
      console.log(`requeued ${n} pre-fix unreachable row(s) as meta_retry:1`);
    }

    // Retry tier — Shopify-hosted stores that were silent last time, plus gone stores (404/410/DNS)
    // waiting for the second consecutive miss that makes them dead. Unindexed, so gated by hour.
    const attempts = new Map();
    const retryDue = RETRY_NOW || REQUEUE || new Date().getHours() % RETRY_EVERY_H === 0;
    // Two queries, half the budget each, so ~19k silent retries can't starve the gone confirmations.
    const half = Math.floor(Math.min(RETRY_LIMIT, LIMIT) / 2);
    const confirm = retryDue ? await sql`SELECT domain, country_source FROM imported_stores
      WHERE published AND country IS NULL AND platform = 'Shopify'
        AND country_checked_at < now() - ${RETRY_AFTER}::interval
        AND country_source = ANY(${GONE_SRC}) AND live_miss = 1
        AND live_status IS DISTINCT FROM 'dead' AND live_status IS DISTINCT FROM 'migrated'
      LIMIT ${half}` : [];
    const silent = retryDue ? await sql`SELECT domain, country_source FROM imported_stores
      WHERE published AND country IS NULL AND platform = 'Shopify'
        AND country_checked_at < now() - ${RETRY_AFTER}::interval
        AND country_source LIKE 'meta_retry:%'
      LIMIT ${Math.min(RETRY_LIMIT, LIMIT) - confirm.length}` : [];
    const retry = [...confirm, ...silent];
    for (const r of retry) {
      if (r.country_source.startsWith("meta_retry:")) attempts.set(r.domain, parseInt(r.country_source.split(":")[1], 10) || 1);
    }

    let crux = [], active = [];
    const room = () => LIMIT - retry.length - crux.length - active.length;
    crux = await sql`SELECT domain FROM imported_stores WHERE ${base} AND crux_rank IS NOT NULL
      ORDER BY crux_rank LIMIT ${Math.max(0, LIMIT - retry.length)}`;
    active = room() > 0 ? await sql`SELECT domain FROM imported_stores WHERE ${base}
      AND live_status = 'active' AND crux_rank IS NULL LIMIT ${room()}` : [];
    const rest = room() > 0 ? await sql`SELECT domain FROM imported_stores WHERE ${base}
      AND live_status IS NULL LIMIT ${room()}` : [];
    const rows = [...retry, ...crux, ...active, ...rest].map((r) => r.domain);
    console.log(`queue: ${rows.length} (retry ${retry.length}${retryDue ? "" : " — not due this hour"}, crux ${crux.length}, `
      + `active ${active.length}, unchecked ${rest.length}), `
      + `concurrency ${CONC}, ${PROXIES.length ? `${PROXIES.length} proxies` : "DIRECT"}${DRY ? " [DRY RUN]" : ""}`);

    let i = 0, done = 0, hit = 0, throttled = 0, streak = 0, stopped = false, dead = 0;
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
          myshopify_domain = COALESCE(t.myshopify_domain, v.myshop),
          live_miss = CASE WHEN t.live_miss > 0 THEN 0 ELSE t.live_miss END   -- answered = healthy
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
      if (s.length) dead += await applyLiveness(s);
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
        } else if (r.transient) {
          // Silence isn't an answer. DNS (free, off the Shopify budget) says whether to keep trying.
          const dns = await dnsClass(domain);
          const n = (attempts.get(domain) ?? 0) + 1;
          let src;
          if (dns === "gone") src = "meta_miss:dns_gone";
          else if (dns === "off_shopify") src = "meta_miss:dns_off_shopify";
          else if (n >= MAX_ATTEMPTS) src = "meta_miss:unreachable";
          else src = `meta_retry:${n}`;
          const why = src.split(":")[0] === "meta_retry" ? "retry_later" : src.split(":")[1];
          misses[why] = (misses[why] ?? 0) + 1;
          stamps.push({ domain, src });
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
    console.log(`\ndone in ${Math.round(secs)}s (${(done / secs).toFixed(1)}/s). placed ${hit}/${done}, throttled ${throttled}, marked dead ${dead}.`);
    console.log("top countries:", Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, n]) => `${k}:${n}`).join(" "));
    console.log("no answer:", Object.entries(misses).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join(" ") || "none");
  } finally { closeAgents(); await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
