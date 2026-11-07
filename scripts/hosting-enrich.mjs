/** hosting-enrich — the first LIVE hosting-provider signal (today hosting_provider only exists on
 *  rows that carried it from an import). Resolve each store's IP and map it to its network operator
 *  via Team Cymru's free DNS IP→ASN service. ALL DNS — no HTTP — so it's exempt from the shared
 *  Shopify-edge rate budget (see memory: residential-ip-rate-budget) and safe to run anytime.
 *
 *  Caveat: a Cloudflare/CDN-fronted store resolves to the CDN, so it reads "Cloudflare" etc. — the
 *  edge, not the origin host. That's the same limit BuiltWith/StoreLeads hit; still useful.
 *
 *    node --env-file=.env.local scripts/hosting-enrich.mjs [--country ZA] [--limit 3000] [--all] [--concurrency 12]
 */
import postgres from "postgres";
import { promises as dns } from "node:dns";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const ALL = process.argv.includes("--all");
const COUNTRY = arg("--country", null);
const LIMIT = ALL ? 0 : parseInt(arg("--limit", "3000"), 10);
const CONC = parseInt(arg("--concurrency", "12"), 10);   // DNS only → safe at higher concurrency

// Well-known networks → a clean label (the raw Cymru org is a fallback).
const ASN_NAME = {
  62044: "Shopify", 13335: "Cloudflare", 16509: "AWS", 14618: "AWS", 8075: "Microsoft Azure",
  15169: "Google Cloud", 396982: "Google Cloud", 20940: "Akamai", 16625: "Akamai", 54113: "Fastly",
  13238: "Yandex Cloud", 24940: "Hetzner", 14061: "DigitalOcean", 20473: "Vultr", 16276: "OVH",
  26496: "GoDaddy", 46606: "Unified Layer", 398101: "GoDaddy", 2635: "Automattic (WordPress.com)",
  36351: "SoftLayer/IBM", 328320: "Xneelo", 37153: "Xneelo", 10474: "Xneelo (ZA)",
};
function cleanOrg(asn, org) {
  if (ASN_NAME[asn]) return ASN_NAME[asn];
  let o = (org || "").replace(/\s*,\s*[A-Z]{2}\s*$/, "").trim();   // drop trailing ", CC"
  if (o.includes(" - ")) o = o.split(" - ").slice(1).join(" - ").trim();  // "HANDLE - Real Name" → Real Name
  return o || null;
}

async function asnOf(ip) {
  try {
    const rev = ip.split(".").reverse().join(".");
    const [t1] = await dns.resolveTxt(`${rev}.origin.asn.cymru.com`);
    const asn = parseInt(t1.join("").split("|")[0].trim(), 10);
    if (!asn) return null;
    let org = null;
    try { const [t2] = await dns.resolveTxt(`AS${asn}.asn.cymru.com`); org = t2.join("").split("|").pop().trim(); } catch {}
    return { asn, provider: cleanOrg(asn, org) };
  } catch { return null; }
}
async function hostOf(domain) {
  let ips = null;
  for (const h of [domain, `www.${domain}`]) { try { ips = await dns.resolve4(h); if (ips?.length) break; } catch {} }
  if (!ips?.length) return { dead: true };
  const a = await asnOf(ips[0]);
  return a ? { asn: a.asn, provider: a.provider } : { dead: true };
}

// Per-connection timeouts apply to EVERY pooled connection (a bare `SET lock_timeout` only hit one
// connection, not the one the ALTER ran on — which is how the no-op ALTER froze the table on
// 2026-10-29). lock_timeout bounds any DDL wait; statement/idle timeouts kill wedged writes.
const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: Math.min(CONC + 1, 10), idle_timeout: 20,
  connection: { statement_timeout: 30000, idle_in_transaction_session_timeout: 60000, lock_timeout: 3000 } });
try {
  // Only ALTER when the column is genuinely missing — a no-op `ADD COLUMN IF NOT EXISTS` still takes
  // an ACCESS EXCLUSIVE lock and, if it queues behind a slow txn, freezes the whole table.
  const [{ present }] = await sql`SELECT EXISTS(SELECT 1 FROM information_schema.columns
    WHERE table_name='imported_stores' AND column_name='hosting_checked_at') present`;
  if (!present) await sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS hosting_checked_at TIMESTAMPTZ`.catch(() => {});
  const rows = await sql`
    SELECT domain FROM imported_stores
    WHERE published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
      AND (hosting_provider IS NULL OR hosting_provider = '') AND hosting_checked_at IS NULL
      ${COUNTRY ? sql`AND country = ${COUNTRY.toUpperCase()}` : sql``}
    ORDER BY estimated_monthly_sales DESC NULLS LAST, discovered_at DESC NULLS LAST
    ${LIMIT > 0 ? sql`LIMIT ${LIMIT}` : sql``}`;
  console.log(`hosting-enrich: ${rows.length.toLocaleString()} stores (DNS, conc ${CONC})`);

  let i = 0, ok = 0, dead = 0, done = 0; const tally = new Map();
  async function worker() {
    while (i < rows.length) {
      const { domain } = rows[i++];
      const r = await hostOf(domain);
      if (r.dead || !r.provider) {
        dead++;
        await sql`UPDATE imported_stores SET hosting_checked_at = now() WHERE domain = ${domain}`.catch(() => {});
      } else {
        ok++; tally.set(r.provider, (tally.get(r.provider) ?? 0) + 1);
        await sql`UPDATE imported_stores SET hosting_provider = ${r.provider}, hosting_asn = ${r.asn}, hosting_checked_at = now()
          WHERE domain = ${domain}`.catch(() => { ok--; });
      }
      if (++done % 500 === 0) console.log(`  …${done}/${rows.length}  (${ok} resolved)`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log(`\n✓ ${ok} resolved · ${dead} no-DNS. Top hosts:`);
  for (const [k, n] of [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${String(n).padStart(5)}  ${k}`);
} finally { await sql.end(); }
