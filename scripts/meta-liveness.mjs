#!/usr/bin/env node
/**
 * meta-liveness — is every customer-visible Shopify store still on a live Shopify plan? One
 * /meta.json each, through the Webshare fleet, on a ~14-day cycle.
 *
 * Why: verify-liveness is the real check (it reads /products.json, i.e. "still SELLING"), but it
 * runs direct from the home IP at ~600/day, which is a ~4-month cycle over the ~74k visible African
 * Shopify stores. /meta.json is the cheapest Shopify request there is and goes through the proxies,
 * so it costs nothing against the residential budget (see residential-ip-rate-budget). It answers a
 * narrower question — "does Shopify still serve this shop" — and that is exactly the question that
 * catches the expensive mistake: frozen (402) and closed (404) stores still being sold as leads.
 *
 *   STORE_PROBE_PROXY_FILE=~/shopify-radar/proxies.txt \
 *   node --env-file=.env.local scripts/meta-liveness.mjs [--limit 1000] [--concurrency 12] [--dry-run]
 *   node --env-file=.env.local scripts/meta-liveness.mjs --migrate     # once, Joel runs it
 *   node --env-file=.env.local scripts/meta-liveness.mjs --status      # queue + result counts
 *
 * Refuses without the proxy file (it would spend the home IP). --direct overrides for a tiny test.
 * --dry-run still FETCHES (same as meta-identify); it skips every write.
 *
 * COLUMNS. This lane owns two columns and nobody else may write them (liveness-column-ownership):
 *   meta_live_checked_at — this lane's private clock; the queue gates on it.
 *   meta_live_result     — what the last fetch said: ok / frozen_402 / http_404 / html_at_meta / …
 * It also writes the SHARED columns by the shared rules: live_checked_at (13 writers already),
 * live_miss at DEAD_AFTER = 2, live_status, and churn_log only through scripts/lib/churn.mjs.
 * It NEVER writes verified_checked_at, last_alive_at or first_verified_live_at — those mean
 * "verify-liveness confirmed it selling", which a /meta.json answer does not prove.
 *
 * RULES — identical to meta-identify / verify-liveness:
 *   · 200 JSON with an id, or a 404 stamped powered-by Oxygen/Hydrogen (headless storefronts have
 *     no /meta.json) → answered: live_miss back to 0, a NULL live_status becomes 'active'.
 *     An existing status is left alone (off_24 is focus-liveness's DNS verdict; not ours to undo).
 *   · 402 frozen / 423 locked → 'dead' on first sight (#163: Shopify itself suspended it).
 *   · 404 / 410 while DNS still points at Shopify's 23.227.38.0/24, or DNS gone → live_miss+1,
 *     'dead' at 2. A 404 from a host OFF Shopify is recorded as http_404_off_shopify and NOT counted:
 *     it is a site that left Shopify (or was mislabelled), not a closed shop. The second look comes from the confirm tier
 *     a day later, and the counter is shared, so verify-liveness's or focus-liveness's miss counts.
 *   · reachable but not Shopify (html_at_meta, dns_off_shopify), 403, silence still on Shopify DNS
 *     → recorded, NOT churned. A move is verify-liveness's call (MIGRATE_AFTER), not this lane's.
 *   · 429 → not an answer. Stays queued; a streak or a sustained 20% rate ends the run.
 *
 * Queue (idx_is_live_universe: country, platform, live_status WHERE published — ~90k rows, no scan),
 * biggest account first within each tier (store_priority):
 *   1. confirm — gone at live_miss >= 1, checked here more than a day ago
 *   2. retry   — silent last time, more than RETRY_AFTER ago
 *   3. never checked by this lane
 *   4. stale   — oldest meta_live_checked_at past CYCLE
 *
 * Undo: UPDATE imported_stores SET meta_live_checked_at=NULL, meta_live_result=NULL; and the deaths
 * are the rows WHERE live_status='dead' AND meta_live_result IN ('frozen_402','http_423','http_404',
 * 'http_410','dns_gone') plus their churn_log rows.
 */
import postgres from "postgres";
import { Resolver } from "node:dns/promises";
import { loadProxies, pickProxy, fetchText, closeAgents } from "./lib/proxy-fetch.mjs";
import { logChurn } from "./lib/churn.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const LIMIT = parseInt(arg("--limit", "1000"), 10);
const CONC = parseInt(arg("--concurrency", "12"), 10);
const CYCLE = arg("--cycle", "14 days");
const RETRY_AFTER = "3 days";
const CONFIRM_AFTER = "1 day";
const DRY = process.argv.includes("--dry-run");
const DIRECT = process.argv.includes("--direct");
const MIGRATE = process.argv.includes("--migrate");
const STATUS = process.argv.includes("--status");
const SHOW = process.argv.includes("--show");      // print every non-ok domain (spot-checking)
const FLUSH = 200;
const MAX_429_STREAK = 25;
const MAX_429_RATE = 0.2;
const DEAD_AFTER = 2;                                          // = verify-liveness.mjs DEAD_AFTER
const DEAD_NOW = new Set(["frozen_402", "http_423"]);
const GONE = new Set(["http_404", "http_410", "dns_gone"]);
const RETRY = ["unreachable"];
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
// = VISIBLE_MARKETS in lib/markets.ts. Customer-visible only: this lane exists to keep the sold base honest.
const MARKETS = ["ZA", "KE", "NG", "EG", "MA", "GH", "TZ", "UG", "DZ", "TN", "CI", "SN", "MU", "MZ",
  "CM", "BW", "AO", "NA", "RW", "ZM", "ET", "ZW", "LY", "MW", "SO", "LS", "SZ"];

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 2, idle_timeout: 20,
  connection: { statement_timeout: 120000, idle_in_transaction_session_timeout: 120000 } });

/** One DDL statement with a short lock wait, retried while busy writers hold the table — same as
 *  lib/field-locks.ts. ADD COLUMN needs ACCESS EXCLUSIVE on a table that is written constantly. */
async function ddl(stmt) {
  for (let attempt = 1; ; attempt++) {
    try {
      await sql.begin(async (q) => { await q`SET LOCAL lock_timeout = '3s'`; await q.unsafe(stmt); });
      return;
    } catch (e) {
      if (e.code !== "55P03" || attempt >= 20) throw e;      // 55P03 = lock_not_available
      console.log(`  table busy, retrying (${attempt})`);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}

async function haveColumns() {
  const r = await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public'
    AND table_name = 'imported_stores' AND column_name IN ('meta_live_checked_at', 'meta_live_result')`;
  return r.length === 2;
}

async function migrate() {
  // Catalog first: ADD COLUMN IF NOT EXISTS still queues for ACCESS EXCLUSIVE (postgres-schema-check-lock).
  const have = new Set((await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public'
    AND table_name = 'imported_stores' AND column_name IN ('meta_live_checked_at', 'meta_live_result')`).map((r) => r.column_name));
  for (const [col, type] of [["meta_live_checked_at", "timestamptz"], ["meta_live_result", "text"]]) {
    if (have.has(col)) { console.log(`${col}: already there`); continue; }
    await ddl(`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS ${col} ${type}`);
    console.log(`added imported_stores.${col}`);
  }
}

const resolver = new Resolver({ timeout: 4000, tries: 2 });
resolver.setServers(["1.1.1.1", "8.8.8.8"]);
async function dnsClass(domain) {            // DNS is exempt from the Shopify-edge budget
  try {
    const ips = await resolver.resolve4(domain);
    if (!ips.length) return "gone";
    return ips.some((ip) => ip.startsWith("23.227.38.")) ? "shopify" : "off_shopify";
  } catch (e) {
    return e.code === "ENOTFOUND" || e.code === "ENODATA" ? "gone" : "unknown";
  }
}

const PROXIES = loadProxies();

async function metaOnce(host) {
  const r = await fetchText(`https://${host}/meta.json`, {
    proxy: pickProxy(PROXIES), timeoutMs: 10_000, maxBytes: 64_000, ua: UA, redirects: 3,
  });
  if (!r) return { miss: "unreachable", transient: true };
  if (r.status === 429) return { miss: "blocked_429", throttled: true };
  if (r.status === 402) return { miss: "frozen_402" };
  if (r.status === 403) return { miss: "blocked_403" };
  if (r.status >= 500) return { miss: `http_${r.status}`, transient: true };
  // Headless (Hydrogen on Oxygen) storefronts don't serve /meta.json at all: Crocs SA and Under
  // Armour SA both 404 here while selling. Shopify still answers, so the shop is alive.
  if (r.status === 404 && /oxygen|hydrogen/i.test(r.poweredBy ?? "")) return { headless: true };
  if (r.status !== 200) return { miss: `http_${r.status}` };
  if (!r.contentType.toLowerCase().includes("json")) return { miss: "html_at_meta" };
  try {
    const d = JSON.parse(r.text);
    return d && typeof d === "object" && d.id ? { shop: d } : { miss: "json_no_id" };
  } catch { return { miss: "bad_json" }; }
}

// Same shape as meta-identify: one more try on another proxy for silence, and www. falls back to
// the apex (www. can hard-404 meta.json while the apex serves it).
async function getMeta(domain) {
  let r = await metaOnce(domain);
  if (r.transient) r = await metaOnce(domain);
  if (r.shop || r.headless || r.throttled || !/^www\./i.test(domain)) return r;
  const apex = await metaOnce(domain.slice(4));
  return apex.shop || apex.headless ? apex : r;
}

async function status() {
  if (!(await haveColumns())) { console.log("meta-liveness: columns not migrated yet (run --migrate)"); return; }
  const r = await sql`SELECT
      count(*)::int AS visible,
      count(*) FILTER (WHERE meta_live_checked_at IS NULL)::int AS never,
      count(*) FILTER (WHERE meta_live_checked_at < now() - ${CYCLE}::interval)::int AS stale,
      count(*) FILTER (WHERE meta_live_checked_at > now() - interval '1 day')::int AS last_24h
    FROM imported_stores WHERE published AND platform = 'Shopify' AND country = ANY(${MARKETS})
      AND live_status IS DISTINCT FROM 'dead' AND live_status IS DISTINCT FROM 'migrated'`;
  console.log(r[0]);
  console.log(await sql`SELECT meta_live_result, count(*)::int n FROM imported_stores
    WHERE published AND platform = 'Shopify' AND country = ANY(${MARKETS}) AND meta_live_result IS NOT NULL
    GROUP BY 1 ORDER BY 2 DESC`);
}

async function queue(migrated) {
  const base = sql`s.published AND s.platform = 'Shopify' AND s.country = ANY(${MARKETS})
    AND s.live_status IS DISTINCT FROM 'dead' AND s.live_status IS DISTINCT FROM 'migrated'`;
  const pick = (where, n) => n <= 0 ? [] : sql`SELECT s.domain FROM imported_stores s
    LEFT JOIN store_priority p ON p.domain = s.domain
    WHERE ${base} AND ${where}
    ORDER BY p.account_score DESC NULLS LAST, s.domain LIMIT ${n}`;
  // Before --migrate the lane's columns don't exist: every row is "never checked" (dry-run only).
  if (!migrated) return { confirm: [], retry: [], never: await pick(sql`true`, LIMIT), stale: [] };
  const confirm = await pick(sql`s.meta_live_result = ANY(${[...GONE]}) AND s.live_miss >= 1
    AND s.meta_live_checked_at < now() - ${CONFIRM_AFTER}::interval`, LIMIT);
  const retry = await pick(sql`s.meta_live_result = ANY(${RETRY})
    AND s.meta_live_checked_at < now() - ${RETRY_AFTER}::interval`, LIMIT - confirm.length);
  const never = await pick(sql`s.meta_live_checked_at IS NULL`, LIMIT - confirm.length - retry.length);
  const room = LIMIT - confirm.length - retry.length - never.length;
  const stale = room <= 0 ? [] : await sql`SELECT s.domain FROM imported_stores s WHERE ${base}
    AND s.meta_live_checked_at < now() - ${CYCLE}::interval
    AND NOT (s.meta_live_result = ANY(${[...GONE, ...RETRY]}))
    ORDER BY s.meta_live_checked_at LIMIT ${room}`;
  return { confirm, retry, never, stale };
}

async function main() {
  if (MIGRATE) return migrate();
  if (STATUS) return status();
  if (!PROXIES.length && !DIRECT) {
    console.error("meta-liveness: STORE_PROBE_PROXY_FILE unset/empty — refusing to spend the home IP. Use --direct for a tiny test.");
    process.exitCode = 2; return;
  }
  const migrated = await haveColumns();
  if (!migrated && !DRY) { console.error("meta-liveness: run --migrate first (columns missing)"); process.exitCode = 2; return; }

  const q = await queue(migrated);
  const rows = [...q.confirm, ...q.retry, ...q.never, ...q.stale].map((r) => r.domain);
  console.log(`queue: ${rows.length} (confirm ${q.confirm.length}, retry ${q.retry.length}, never ${q.never.length}, `
    + `stale ${q.stale.length}), concurrency ${CONC}, ${PROXIES.length ? `${PROXIES.length} proxies` : "DIRECT"}`
    + `${DRY ? " [DRY RUN — fetches, writes nothing]" : ""}${migrated ? "" : " [columns not migrated]"}`);

  let i = 0, done = 0, throttled = 0, streak = 0, stopped = false, dead = 0;
  const tally = {};
  let batch = [];
  const t0 = Date.now();

  async function flush() {
    const b = batch; batch = [];
    if (DRY || !b.length) return;
    // 1. This lane's own clock and verdict, for every answered row.
    await sql`UPDATE imported_stores t SET meta_live_checked_at = now(), meta_live_result = v.res,
        live_checked_at = now()
      FROM (SELECT * FROM unnest(${b.map((x) => x.domain)}::text[], ${b.map((x) => x.res)}::text[]) AS u(domain, res)) v
      WHERE t.domain = v.domain`;
    // 2. Answered → healthy. Identity columns fill only where blank.
    const ok = b.filter((x) => x.res === "ok" || x.res === "ok_headless");
    if (ok.length) await sql`UPDATE imported_stores t SET
        live_miss = CASE WHEN t.live_miss > 0 THEN 0 ELSE t.live_miss END,
        live_status = COALESCE(t.live_status, 'active'),
        shop_id = COALESCE(t.shop_id, v.shop_id),
        shop_country = COALESCE(t.shop_country, v.shop_country),
        shop_currency = COALESCE(t.shop_currency, v.currency),
        myshopify_domain = COALESCE(t.myshopify_domain, v.myshop)
      FROM (SELECT * FROM unnest(${ok.map((x) => x.domain)}::text[], ${ok.map((x) => x.shop_id)}::bigint[],
        ${ok.map((x) => x.shop_country)}::text[], ${ok.map((x) => x.currency)}::text[], ${ok.map((x) => x.myshop)}::text[])
        AS u(domain, shop_id, shop_country, currency, myshop)) v
      WHERE t.domain = v.domain`;
    // 3. Deaths, by the shared rules.
    const flipped = [];
    const deadNow = b.filter((x) => DEAD_NOW.has(x.res)).map((x) => x.domain);
    if (deadNow.length) {
      const r = await sql`UPDATE imported_stores SET live_status = 'dead', live_miss = COALESCE(live_miss, 0) + 1
        WHERE domain = ANY(${deadNow}) AND live_status IS DISTINCT FROM 'dead' AND live_status IS DISTINCT FROM 'migrated'
        RETURNING domain`;
      flipped.push(...r.map((x) => x.domain));
    }
    const gone = b.filter((x) => GONE.has(x.res)).map((x) => x.domain);
    if (gone.length) {
      const r = await sql`UPDATE imported_stores SET live_miss = COALESCE(live_miss, 0) + 1,
          live_status = CASE WHEN COALESCE(live_miss, 0) + 1 >= ${DEAD_AFTER} THEN 'dead' ELSE live_status END
        WHERE domain = ANY(${gone}) AND live_status IS DISTINCT FROM 'dead' AND live_status IS DISTINCT FROM 'migrated'
        RETURNING domain, live_status`;
      flipped.push(...r.filter((x) => x.live_status === "dead").map((x) => x.domain));
    }
    await logChurn(sql, flipped, "dead");
    dead += flipped.length;
  }

  async function worker() {
    while (!stopped && i < rows.length) {
      const domain = rows[i++];
      const r = await getMeta(domain);
      done++;
      if (r.throttled) {
        throttled++;
        if (++streak >= MAX_429_STREAK) { stopped = true; console.log(`  ${streak} straight 429s — stopping.`); }
        if (done >= 200 && throttled / done > MAX_429_RATE) { stopped = true; console.log(`  429 rate ${(100 * throttled / done).toFixed(1)}% — stopping.`); }
        continue;
      }
      streak = 0;
      let res;
      if (r.shop) res = "ok";
      else if (r.headless) res = "ok_headless";
      else if (r.transient) {
        const dns = await dnsClass(domain);
        res = dns === "gone" ? "dns_gone" : dns === "off_shopify" ? "dns_off_shopify" : "unreachable";
      } else if (GONE.has(r.miss)) {
        // A 404 only means "closed" when SHOPIFY says it. Dry-run 2026-11-24, top 300 visible ZA/
        // Africa accounts: 21 x 404 at /meta.json, and most resolved OFF Shopify's /24 (AWS, Cloudflare,
        // own hosting): live sites that have left Shopify or were mislabelled, not dead shops. Those are
        // recorded as <code>_off_shopify and left for verify-liveness's migration check.
        res = (await dnsClass(domain)) === "shopify" ? r.miss : `${r.miss}_off_shopify`;
      } else res = r.miss;
      tally[res] = (tally[res] ?? 0) + 1;
      if (SHOW && res !== "ok") console.log(`    ${res}\t${domain}`);
      const m = r.shop || {};
      batch.push({ domain, res, shop_id: Number(m.id) || null, shop_country: m.country || null,
        currency: m.currency || null, myshop: m.myshopify_domain || null });
      if (batch.length >= FLUSH) await flush();
      if (done % 250 === 0) {
        const rate = done / ((Date.now() - t0) / 1000);
        console.log(`  ${done}/${rows.length}  ok ${tally.ok ?? 0} (${(100 * (tally.ok ?? 0) / done).toFixed(0)}%)  429 ${throttled}  ${rate.toFixed(1)}/s`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  await flush();
  const secs = (Date.now() - t0) / 1000;
  console.log(`done in ${Math.round(secs)}s (${(done / Math.max(secs, 1)).toFixed(1)}/s). answered ok ${tally.ok ?? 0}/${done}, `
    + `throttled ${throttled}, marked dead ${DRY ? "(dry run: 0)" : dead}.`);
  console.log("results:", Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join(" ") || "none");
}

main().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { closeAgents(); await sql.end(); });
