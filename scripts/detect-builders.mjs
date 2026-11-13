#!/usr/bin/env node
// detect-builders — DNS-only platform reclassification against the shared hosted-platform table
// (Shopify, Wix, Squarespace, Webflow, BigCommerce, Cafe24, Tiendanube, Square Online, … — see
// scripts/lib/hosted-platforms.json, vendored from shopify-radar/hosted_platforms.json, where every
// anchor carries the evidence that justified it).
//
// Hosted platforms put every store behind shared/wildcard certs or their own edge, so a custom
// domain still points its DNS at the platform's infra. We resolve each unclassified domain's
// CNAME chain (the domain itself and www.) + apex/www A records and match the table. DNS is EXEMPT
// from the Shopify-edge rate budget, so this runs at real concurrency with no homepage fetch.
//
// Scope = WORLDWIDE rows we treat as store-candidates but haven't platformed: platform IS NULL or
// 'custom', any country (incl. country-less). --country narrows it. Reclassifying platform does NOT
// publish (builders are confirmed by the builder-promote lane, wix-store-audit.mjs --promote; the
// dedicated-commerce platforms stay banked until a publish decision is made per platform) — it just
// corrects coverage. Stamps dns_checked_at on every domain resolved (builder or not) so re-runs drain
// the pool. A row checked BEFORE the table's `version` date is re-checked once, so a newly added
// fingerprint applies retroactively without a manual reset. Resumable.
//
//   node --env-file=.env.local scripts/detect-builders.mjs --sample 40          # resolve+print, no writes
//   node --env-file=.env.local scripts/detect-builders.mjs --dry --limit 30000  # resolve all, tally, no writes
//   node --env-file=.env.local scripts/detect-builders.mjs --limit 50000 [--country ZA]
import postgres from "postgres";
import { Resolver } from "node:dns/promises";
import { loadHostedPlatforms, matchHosted } from "./lib/hosted-platforms.mjs";
import { canonicalPlatform } from "../lib/platform-canon.ts";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SAMPLE = Number(arg("--sample", "0"));
const DRY = process.argv.includes("--dry") || SAMPLE > 0;
const LIMIT = SAMPLE || Number(arg("--limit", "50000"));
const COUNTRY = arg("--country", "").toUpperCase();
const CONC = Number(arg("--conc", "25"));          // DNS is rate-exempt → real concurrency
const TIMEOUT = Number(arg("--timeout", "4000"));

const TABLE = loadHostedPlatforms();
// Rows stamped before this date were checked against an older table → re-check them once.
const FP_SINCE = TABLE.version;

// One resolver per WORKER (not per domain — that serialized against the local resolver and crawled
// at ~3/s). Point it at fast public DNS so high concurrency actually parallelizes; hard timeout so a
// hung lookup never wedges the lane.
function makeResolver() {
  const r = new Resolver({ timeout: TIMEOUT, tries: 1 });
  try { r.setServers(["1.1.1.1", "8.8.8.8", "1.0.0.1", "8.8.4.4"]); } catch { /* fall back to system DNS */ }
  return r;
}
// resolveCname returns one hop; follow the chain (≤4 hops) so a customer alias in front of the
// platform host (shop.brand.com → brand.vip.myshopline.shop → …) still exposes the anchor.
async function cnameChain(r, host) {
  const out = [];
  let h = host;
  for (let i = 0; i < 4; i++) {
    let next;
    try { next = (await r.resolveCname(h))[0]; } catch { break; }
    if (!next || out.includes(next)) break;
    out.push(next);
    h = next;
  }
  return out;
}
async function resolveDomain(r, domain) {
  const safe = async (fn, host) => { try { return await fn.call(r, host); } catch { return []; } };
  const www = domain.startsWith("www.") ? null : `www.${domain}`;
  const [apexA, apexC, wwwC, wwwA] = await Promise.all([
    safe(r.resolve4, domain),
    cnameChain(r, domain),
    www ? cnameChain(r, www) : [],
    www ? safe(r.resolve4, www) : [],
  ]);
  return { cnames: [...apexC, ...wwwC], a4: [...apexA, ...wwwA] };
}

async function main() {
  console.log(`detect-builders${SAMPLE ? ` [SAMPLE ${SAMPLE}]` : DRY ? " [DRY]" : ""} · conc ${CONC} · ` +
    `${COUNTRY || "worldwide"} · fingerprints ${TABLE.version} (${TABLE.platforms.length} platforms)`);
  // Small DB pool on purpose: DNS runs at high concurrency but writes are quick batched UPDATEs,
  // so a tiny pool is plenty — and keeps this lane from crowding the shared Supabase pooler (which
  // starves the live dashboard) when it runs alongside the other writers.
  const sql = postgres(process.env.DATABASE_URL || process.env.POSTGRES_URL, { ssl: "require", max: 3, prepare: false,
    connection: { statement_timeout: 30000, idle_in_transaction_session_timeout: 60000, lock_timeout: 5000 } });
  try {
    // Resumable marker column (guarded ALTER — only runs if genuinely missing, so a no-op never takes
    // an exclusive lock; lock_timeout bounds it either way). Cheap nullable column.
    const [{ present }] = await sql`SELECT EXISTS(SELECT 1 FROM information_schema.columns
      WHERE table_name='imported_stores' AND column_name='dns_checked_at') present`;
    if (!present && !DRY) await sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS dns_checked_at TIMESTAMPTZ`.catch(() => {});

    // Process in BATCHES: resolve a batch at DNS concurrency, then BULK-write it in a handful of
    // `domain = ANY($array)` UPDATEs (one-UPDATE-per-domain capped the lane at ~1/s). Each batch
    // commits its dns_checked_at marks, so the lane stays resumable. A dry run can't stamp, so it
    // walks the pool with a keyset cursor on domain instead.
    const BATCH = SAMPLE ? LIMIT : 3000;
    const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
    const found = {}; let totalDone = 0, totalHits = 0, dbErrs = 0, after = "";
    while (totalDone < LIMIT) {
      const rows = await sql`
        SELECT domain, country FROM imported_stores
        WHERE (platform IS NULL OR platform = 'custom')
          AND (dns_checked_at IS NULL OR dns_checked_at < ${FP_SINCE}::date)
          AND domain NOT LIKE '%/%'
          ${COUNTRY ? sql`AND country = ${COUNTRY}` : sql``}
          ${DRY && !SAMPLE ? sql`AND domain > ${after} ORDER BY domain` : sql``}
        LIMIT ${Math.min(BATCH, LIMIT - totalDone)}`;
      if (!rows.length) { if (totalDone === 0) console.log("nothing to resolve — builder pool drained."); break; }
      after = rows.at(-1).domain;

      // resolve the batch — collect matches (grouped by platform) + every checked domain
      const matches = {}; const checked = []; let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(CONC, rows.length) }, async () => {
        const r = makeResolver();   // one resolver per worker (pointed at public DNS)
        while (cursor < rows.length) {
          const { domain, country } = rows[cursor++];
          const { cnames, a4 } = await resolveDomain(r, domain);
          const hit = matchHosted(TABLE, domain, cnames, a4);
          const plat = hit ? canonicalPlatform(hit.name) : null;
          checked.push(domain);
          if (plat) (matches[plat] ??= []).push(domain);
          if (SAMPLE) console.log(`  ${domain} [${country ?? "—"}] → ${plat ?? "—"}${plat ? ` (${hit.kind})` : `  (cname:${cnames[0] ?? "none"} a:${a4[0] ?? "none"})`}`);
        }
      }));

      if (!DRY) {
        // bulk write: reclassify matched domains per platform, then stamp dns_checked_at on all checked
        for (const [plat, doms] of Object.entries(matches)) {
          for (const c of chunk(doms, 1000)) {
            await sql`UPDATE imported_stores SET platform = ${plat}, hosting_provider = ${plat}, dns_checked_at = now()
              WHERE domain = ANY(${c}) AND (platform IS NULL OR platform = 'custom')`.catch((e) => { if (++dbErrs <= 8) console.log(`  ! db: ${e.message}`); });
          }
        }
        for (const c of chunk(checked, 1000)) {
          await sql`UPDATE imported_stores SET dns_checked_at = now()
            WHERE domain = ANY(${c}) AND (dns_checked_at IS NULL OR dns_checked_at < ${FP_SINCE}::date)`.catch((e) => { if (++dbErrs <= 8) console.log(`  ! db: ${e.message}`); });
        }
      }

      totalDone += rows.length;
      for (const [p, d] of Object.entries(matches)) { found[p] = (found[p] ?? 0) + d.length; totalHits += d.length; }
      if (!SAMPLE) process.stdout.write(`\r  ${totalDone} resolved · matched ${totalHits}`);
      if (rows.length < BATCH) break;   // pool drained for this scope
    }
    console.log(`\ndone. ${totalDone} resolved · ${totalHits} matched${DRY ? " (dry — nothing written)" : ""} · db-errs: ${dbErrs}`);
    console.log("breakdown:", found);
  } catch (e) { console.error("ERR", e.message); process.exitCode = 1; }
  finally { await sql.end(); }
}
main();
