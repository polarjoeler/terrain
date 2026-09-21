/** dns-liveness — fast, residential-IP-SAFE liveness via DNS only (rate-exempt). Shopify custom
 *  domains resolve to 23.227.38.0/24. Marks: active (on /24), off_24 (resolves elsewhere — could be
 *  a real migration OR Cloudflare-fronted Shopify; leave for a small paced HTML recheck), dead (NXDOMAIN).
 *  Does NOT do HTTP fetches, so it will not touch the shared residential-IP budget.
 *
 *    node --env-file=.env.local scripts/dns-liveness.mjs --source storecensus [--country JP] [--limit N]
 */
import postgres from "postgres";
import { promises as dns } from "dns";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SRC = arg("--source", "storecensus");
const CTY = (arg("--country", "") || "").toUpperCase();
const LIMIT = parseInt(arg("--limit", "0"), 10) || 0;
const CONC = parseInt(arg("--conc", "60"), 10);

async function state(d) {
  for (const h of [d, `www.${d}`]) {
    try {
      const ips = await dns.resolve4(h);
      if (ips.some((i) => i.startsWith("23.227.38."))) return "active";
      if (ips.length) return "off_24";
    } catch { /* try www, then fall through */ }
  }
  return "dead";
}
async function mapLimit(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 5, idle_timeout: 20 });
try {
  const cty = CTY ? sql`AND UPPER(country) = ${CTY}` : sql``;
  const lim = LIMIT ? sql`LIMIT ${LIMIT}` : sql``;
  const rows = await sql`SELECT regexp_replace(domain, '^www\\.', '') d, domain
    FROM imported_stores
    WHERE source = ${SRC} AND lower(platform) = 'shopify' AND live_checked_at IS NULL ${cty}
    ORDER BY estimated_monthly_sales DESC NULLS LAST ${lim}`;
  console.log(`dns-liveness[${SRC}${CTY ? "/" + CTY : ""}]: ${rows.length} stores (DNS only, conc ${CONC})`);
  let active = 0, off = 0, dead = 0, done = 0;
  await mapLimit(rows, CONC, async (r) => {
    const st = await state(r.d);
    st === "active" ? active++ : st === "off_24" ? off++ : dead++;
    done++;
    await sql`UPDATE imported_stores SET live_status = ${st}, live_checked_at = now() WHERE domain = ${r.domain}`.catch(() => {});
    if (done % 5000 === 0) console.log(`  …${done}/${rows.length}  active=${active} off_24=${off} dead=${dead}`);
  });
  const t = rows.length || 1;
  console.log(`done: active ${active} (${Math.round(100 * active / t)}%) · off_24 ${off} (${Math.round(100 * off / t)}%) · dead ${dead} (${Math.round(100 * dead / t)}%)`);
  console.log(`  off_24 = candidates for a small, paced HTML recheck (Cloudflare-fronted Shopify vs true migration).`);
} finally { await sql.end(); }
