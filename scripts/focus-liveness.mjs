/** focus-liveness — the Tier-B freshness engine: RE-checks focus-market stores so churn (dead) and
 *  migrations (Shopify off its /24) stay current. DNS only (rate-exempt, no HTTP), so it's safe to run
 *  flat-out from any box. Unlike dns-liveness (first-checks Shopify by source), this re-checks ANY
 *  published focus store whose liveness is stale, stalest first.
 *
 *    node --env-file=.env.local scripts/focus-liveness.mjs [--country ZA,KE,NG] [--recheck-days 14] [--limit 20000]
 *
 *  Marks: active · off_24 (Shopify resolving off 23.227.38.0/24 → migration candidate) · dead (NXDOMAIN).
 *  Runs on Lucy (own-domain/DNS worker). Churn = a store going active→dead; migration = active→off_24.
 *
 *  SHARES THREE THINGS WITH verify-liveness, deliberately:
 *   1. the live_miss counter. `dead` is terminal across the app (every customer query excludes it),
 *      so one NXDOMAIN must not churn a store out — a DNS blip, an expired-then-renewed domain or a
 *      registrar hiccup all look identical to death for one pass. Same DEAD_AFTER = 2 rule as
 *      verify-liveness, over the same column, so the two lanes' misses CONFIRM each other instead
 *      of racing: either lane seeing it alive resets the counter.
 *   2. churn_log, via scripts/lib/churn.mjs. Without this a DNS-confirmed death pulled the store
 *      out of the live base and was counted by Mission Control's churn30 (live_status='dead') while
 *      Insights, which counts churn_log.died_at, never saw it — two churn numbers that disagreed.
 *      churn_log's domain PK + ON CONFLICT DO NOTHING means the first lane to confirm logs it once.
 *   3. live_checked_at, which it stamps on every row it touches. What it must NOT touch is
 *      last_alive_at: that means "last confirmed SELLING" and churn_log.died_at is read from it, so
 *      stamping it on a mere DNS answer re-dated every death to ~today. verify-liveness owns it
 *      (it only stamps on a real /products.json catalogue), and verified_checked_at keeps this
 *      lane's cheap check from hiding rows from that expensive one.
 */
import postgres from "postgres";
import { promises as dns } from "dns";
import { logChurn } from "./lib/churn.mjs";

const DEAD_AFTER = 2;   // consecutive misses before `dead` — same rule, same column, as verify-liveness

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const CTY = (arg("--country", "ZA,KE,NG") || "").toUpperCase().split(",").map((s) => s.trim()).filter(Boolean);
const RECHECK = parseInt(arg("--recheck-days", "14"), 10);
const LIMIT = parseInt(arg("--limit", "20000"), 10) || 0;
const CONC = parseInt(arg("--conc", "60"), 10);

async function state(d, isShopify) {
  for (const h of [d, `www.${d}`]) {
    try {
      const ips = await dns.resolve4(h);
      if (isShopify) { if (ips.some((i) => i.startsWith("23.227.38."))) return "active"; if (ips.length) return "off_24"; }
      else if (ips.length) return "active";
    } catch { /* try www, then dead */ }
  }
  return "dead";
}
async function mapLimit(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 5, idle_timeout: 20 });
try {
  const lim = LIMIT ? sql`LIMIT ${LIMIT}` : sql``;
  const rows = await sql`SELECT regexp_replace(domain, '^www\\.', '') d, domain, lower(platform) platform, live_status, live_miss
    FROM imported_stores
    WHERE published AND coalesce(activity_tier,'') NOT IN ('not_a_store','dormant')
      AND UPPER(country) = ANY(${CTY})
      AND (live_checked_at IS NULL OR live_checked_at < now() - (${RECHECK} || ' days')::interval)
    ORDER BY live_checked_at ASC NULLS FIRST ${lim}`;
  console.log(`focus-liveness[${CTY.join(",")}] re-check ≥${RECHECK}d stale: ${rows.length} stores (DNS only, conc ${CONC})`);
  let active = 0, off = 0, dead = 0, churn = 0, migrated = 0, pending = 0, done = 0;
  await mapLimit(rows, CONC, async (r) => {
    const isShopify = r.platform === "shopify";
    const st = await state(r.d, isShopify);
    if (st === "active") active++; else if (st === "off_24") off++; else dead++;
    // A DNS answer of any kind (on or off the /24) is the store ANSWERING — it resets the shared
    // miss counter. Only NXDOMAIN is a miss, and it takes DEAD_AFTER of them to write `dead`;
    // below that the store keeps the status it had, so a single blip changes nothing but the count.
    const miss = st === "dead" ? (r.live_miss || 0) + 1 : 0;
    const status = st === "dead" && miss < DEAD_AFTER ? (r.live_status || "active") : st;
    if (status === "dead" && r.live_status !== "dead") churn++;       // newly CONFIRMED dead
    else if (st === "dead") pending++;                               // first miss — not churn yet
    if (r.live_status === "active" && st === "off_24") migrated++;    // Shopify left its /24
    done++;
    await sql`UPDATE imported_stores SET live_status = ${status}, live_checked_at = now(),
      live_miss = ${miss}
      WHERE domain = ${r.domain}`.catch(() => {});
    // Snapshot the lead the moment the death is confirmed, on the same shared path verify-liveness
    // uses. died_at comes off last_alive_at, which this lane never writes, so it stays honest.
    if (status === "dead" && r.live_status !== "dead") await logChurn(sql, r.domain, "dead").catch(() => {});
    if (done % 5000 === 0) console.log(`  …${done}/${rows.length}  active=${active} off_24=${off} dead=${dead}`);
  });
  const t = rows.length || 1;
  console.log(`done: active ${active} · off_24 ${off} · dead ${dead}  (${Math.round(100 * active / t)}% live)`);
  console.log(`  NEW this pass: ${churn} churned + logged (confirmed over ${DEAD_AFTER} checks) · ${pending} first-miss, awaiting confirmation · ${migrated} migration-candidates (Shopify→off_24)`);
} finally { await sql.end(); }
