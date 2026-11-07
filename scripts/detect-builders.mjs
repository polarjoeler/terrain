#!/usr/bin/env node
// detect-builders — DNS-only platform reclassification: Wix / Squarespace / Webflow (+ Shopify).
//
// These builders host every store behind shared/wildcard certs, so the CT + homepage-fingerprint
// engine is blind to them — but a custom domain still points its DNS at the builder's infra. We
// resolve each unclassified domain's www-CNAME + apex/www A records and match the builder's known
// targets (verified live 2026-10-29). DNS is EXEMPT from the Shopify-edge rate budget, so this runs
// at real concurrency with no homepage fetch — the cheapest possible lane.
//
// Scope = rows we already treat as store-candidates but haven't platformed: platform IS NULL or
// 'custom'. Reclassifying their platform does NOT publish them (promote-confirmed still gates on
// confirmation, and Wix/SQSP/Webflow aren't in STORE_NATIVE) — it just corrects coverage. Marks
// dns_checked_at on every domain resolved (builder or not) so re-runs drain the pool. Resumable.
//
//   node --env-file=.env.local scripts/detect-builders.mjs --sample 40          # resolve+print, no writes
//   node --env-file=.env.local scripts/detect-builders.mjs --limit 50000 [--country ZA]
import postgres from "postgres";
import { Resolver } from "node:dns/promises";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SAMPLE = Number(arg("--sample", "0"));
const DRY = process.argv.includes("--dry") || SAMPLE > 0;
const LIMIT = SAMPLE || Number(arg("--limit", "50000"));
const COUNTRY = arg("--country", "").toUpperCase();
const CONC = Number(arg("--conc", "25"));          // DNS is rate-exempt → real concurrency
const TIMEOUT = Number(arg("--timeout", "4000"));

// Builder DNS fingerprints — www-CNAME is the strongest signal; apex/www A is the fallback. Verified
// against known stores 2026-10-29 (e.g. *.wixdns.net, ext-cust.squarespace.com, cdn.webflow.com).
const BUILDERS = [
  // Shopify is here too: the NULL pool is full of CT-discovered Shopify domains that were never
  // platform-confirmed, and their DNS (shops.myshopify.com / 23.227.38.x) is unambiguous — the
  // single biggest reclassification win. Shopify isn't in promote-confirmed STORE_NATIVE, so this
  // corrects coverage without auto-publishing anything.
  { name: "Shopify",     cname: [/myshopify\.com\.?$/i],                a: [/^23\.227\.38\./] },
  { name: "Wix",         cname: [/wixdns\.net\.?$/i, /\.wix\.com\.?$/i], a: [/^185\.230\.63\./, /^23\.236\.62\.147$/] },
  { name: "Squarespace", cname: [/squarespace\.com\.?$/i],              a: [/^198\.185\.159\.(144|145)$/, /^198\.49\.23\.(144|145)$/] },
  { name: "Webflow",     cname: [/webflow\.(com|io)\.?$/i],             a: [/^198\.202\.211\.1$/, /^75\.2\.70\.75$/, /^99\.83\.190\.102$/] },
];

function matchBuilder(cnames, a4) {
  for (const b of BUILDERS) {
    if (cnames.some((c) => b.cname.some((re) => re.test(c)))) return b.name;
    if (a4.some((ip) => b.a.some((re) => re.test(ip)))) return b.name;
  }
  return null;
}

// One resolver per WORKER (not per domain — that serialized against the local resolver and crawled
// at ~3/s). Point it at fast public DNS so high concurrency actually parallelizes; hard timeout so a
// hung lookup never wedges the lane.
function makeResolver() {
  const r = new Resolver({ timeout: TIMEOUT, tries: 1 });
  try { r.setServers(["1.1.1.1", "8.8.8.8", "1.0.0.1", "8.8.4.4"]); } catch { /* fall back to system DNS */ }
  return r;
}
async function resolveDomain(r, domain) {
  const safe = async (fn, host) => { try { return await fn.call(r, host); } catch { return []; } };
  const [apexA, wwwC, wwwA] = await Promise.all([
    safe(r.resolve4, domain),
    safe(r.resolveCname, `www.${domain}`),
    safe(r.resolve4, `www.${domain}`),
  ]);
  return { cnames: wwwC, a4: [...apexA, ...wwwA] };
}

async function main() {
  console.log(`detect-builders${SAMPLE ? ` [SAMPLE ${SAMPLE}]` : DRY ? " [DRY]" : ""} · conc ${CONC}${COUNTRY ? ` · ${COUNTRY}` : ""}`);
  // Small DB pool on purpose: DNS runs at high concurrency but writes are quick single-row UPDATEs,
  // so a tiny pool is plenty — and keeps this lane from crowding the shared Supabase pooler (which
  // starves the live dashboard) when it runs alongside the other writers.
  const sql = postgres(process.env.DATABASE_URL || process.env.POSTGRES_URL, { ssl: "require", max: 3,
    connection: { statement_timeout: 30000, idle_in_transaction_session_timeout: 60000, lock_timeout: 5000 } });
  try {
    // Resumable marker column (guarded ALTER — only runs if genuinely missing, so a no-op never takes
    // an exclusive lock; lock_timeout bounds it either way). Cheap nullable column.
    const [{ present }] = await sql`SELECT EXISTS(SELECT 1 FROM information_schema.columns
      WHERE table_name='imported_stores' AND column_name='dns_checked_at') present`;
    if (!present) await sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS dns_checked_at TIMESTAMPTZ`.catch(() => {});

    // Process in BATCHES: resolve a batch at DNS concurrency (fast — ~38/s), then BULK-write it in a
    // handful of `domain = ANY($array)` UPDATEs. One-UPDATE-per-domain through the small pool capped
    // the lane at ~1/s (write-RTT-bound) even though DNS was 38/s — batching decouples the two. Each
    // batch commits its dns_checked_at marks, so the lane stays resumable. No heavy ORDER BY (sorting
    // the whole NULL pool was 15min/5k); prioritise markets via --country.
    const BATCH = SAMPLE ? LIMIT : 3000;
    const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
    const found = {}; let totalDone = 0, totalHits = 0, dbErrs = 0;
    while (totalDone < LIMIT) {
      const rows = await sql`
        SELECT domain FROM imported_stores
        WHERE (platform IS NULL OR platform = 'custom')
          AND dns_checked_at IS NULL
          AND domain NOT LIKE '%/%'
          ${COUNTRY ? sql`AND country = ${COUNTRY}` : sql``}
        LIMIT ${Math.min(BATCH, LIMIT - totalDone)}`;
      if (!rows.length) { if (totalDone === 0) console.log("nothing to resolve — builder pool drained."); break; }

      // resolve the batch — collect builder matches (grouped by platform) + every checked domain
      const matches = {}; const checked = []; let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(CONC, rows.length) }, async () => {
        const r = makeResolver();   // one resolver per worker (pointed at public DNS)
        while (cursor < rows.length) {
          const { domain } = rows[cursor++];
          const { cnames, a4 } = await resolveDomain(r, domain);
          const builder = matchBuilder(cnames, a4);
          checked.push(domain);
          if (builder) (matches[builder] ??= []).push(domain);
          if (SAMPLE) console.log(`  ${domain} → ${builder ?? "—"}${builder ? "" : `  (cname:${cnames[0] ?? "none"} a:${a4[0] ?? "none"})`}`);
        }
      }));

      if (!SAMPLE) {
        // bulk write: reclassify matched domains per platform, then stamp dns_checked_at on all checked
        for (const [plat, doms] of Object.entries(matches)) {
          for (const c of chunk(doms, 1000)) {
            await sql`UPDATE imported_stores SET platform = ${plat}, hosting_provider = ${plat}, dns_checked_at = now()
              WHERE domain = ANY(${c}) AND (platform IS NULL OR platform = 'custom')`.catch((e) => { if (++dbErrs <= 8) console.log(`  ! db: ${e.message}`); });
          }
        }
        for (const c of chunk(checked, 1000)) {
          await sql`UPDATE imported_stores SET dns_checked_at = now()
            WHERE domain = ANY(${c}) AND dns_checked_at IS NULL`.catch((e) => { if (++dbErrs <= 8) console.log(`  ! db: ${e.message}`); });
        }
      }

      totalDone += rows.length;
      for (const [p, d] of Object.entries(matches)) { found[p] = (found[p] ?? 0) + d.length; totalHits += d.length; }
      if (!SAMPLE) process.stdout.write(`\r  ${totalDone} resolved · builders ${totalHits}`);
      if (rows.length < BATCH) break;   // pool drained for this scope
    }
    console.log(`\ndone. ${totalDone} resolved · ${totalHits} builders · db-errs: ${dbErrs}`);
    console.log("breakdown:", found);
  } catch (e) { console.error("ERR", e.message); process.exitCode = 1; }
  finally { await sql.end(); }
}
main();
