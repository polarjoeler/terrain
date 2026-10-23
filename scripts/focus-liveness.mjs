/** focus-liveness — the Tier-B freshness engine: RE-checks focus-market stores so churn (dead) and
 *  migrations (Shopify off its /24) stay current. DNS only (rate-exempt, no HTTP), so it's safe to run
 *  flat-out from any box. Unlike dns-liveness (first-checks Shopify by source), this re-checks ANY
 *  published focus store whose liveness is stale, stalest first.
 *
 *    node --env-file=.env.local scripts/focus-liveness.mjs [--country ZA,KE,NG] [--recheck-days 14] [--limit 20000]
 *
 *  Marks: active · off_24 (Shopify resolving off 23.227.38.0/24 → migration candidate) · dead (NXDOMAIN).
 *  Runs on Lucy (own-domain/DNS worker). Churn = a store going active→dead; migration = active→off_24.
 */
import postgres from "postgres";
import { promises as dns } from "dns";

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
  const rows = await sql`SELECT regexp_replace(domain, '^www\\.', '') d, domain, lower(platform) platform, live_status
    FROM imported_stores
    WHERE published AND coalesce(activity_tier,'') NOT IN ('not_a_store','dormant')
      AND UPPER(country) = ANY(${CTY})
      AND (live_checked_at IS NULL OR live_checked_at < now() - (${RECHECK} || ' days')::interval)
    ORDER BY live_checked_at ASC NULLS FIRST ${lim}`;
  console.log(`focus-liveness[${CTY.join(",")}] re-check ≥${RECHECK}d stale: ${rows.length} stores (DNS only, conc ${CONC})`);
  let active = 0, off = 0, dead = 0, churn = 0, migrated = 0, done = 0;
  await mapLimit(rows, CONC, async (r) => {
    const isShopify = r.platform === "shopify";
    const st = await state(r.d, isShopify);
    if (st === "active") active++; else if (st === "off_24") off++; else dead++;
    if (r.live_status === "active" && st === "dead") churn++;         // went dark since last check
    if (r.live_status === "active" && st === "off_24") migrated++;    // Shopify left its /24
    done++;
    await sql`UPDATE imported_stores SET live_status = ${st}, live_checked_at = now(),
      last_alive_at = CASE WHEN ${st} <> 'dead' THEN now() ELSE last_alive_at END
      WHERE domain = ${r.domain}`.catch(() => {});
    if (done % 5000 === 0) console.log(`  …${done}/${rows.length}  active=${active} off_24=${off} dead=${dead}`);
  });
  const t = rows.length || 1;
  console.log(`done: active ${active} · off_24 ${off} · dead ${dead}  (${Math.round(100 * active / t)}% live)`);
  console.log(`  NEW this pass: ${churn} churned (active→dead) · ${migrated} migration-candidates (Shopify→off_24)`);
} finally { await sql.end(); }
