/** Land non-Shopify hosted-CMS discoveries (Wix, Squarespace, Webflow, BigCommerce, Cafe24,
 *  BASE, Tiendanube, Square Online, …) detected by their DNS anchor — by bulk_classify.py (every
 *  seed, incl. the CT firehose) and, with CT_HOSTED_TAG=1, by ct_tail.py itself (source=ct_hosted).
 *  The fingerprint table both use is shopify-radar/hosted_platforms.json.
 *
 *  These are BANKED, NOT SURFACED: inserted published=FALSE so they populate the /ops
 *  coverage "other" column and let us size each platform's footprint, WITHOUT entering
 *  insights / reports / the customer dashboard (those filter published=true) until we
 *  decide a platform is ready. Builder rows (Wix/Squarespace/Webflow) become leads only via
 *  the builder-promote lane (wix-store-audit.mjs --promote), which confirms commerce first.
 *
 *  Never downgrades an existing row: on conflict it only backfills discovered_at, a NULL
 *  platform and a NULL cert_not_before (COALESCE), so a confirmed Shopify/Woo/publish is never
 *  clobbered by a later DNS guess.
 *
 *  Reads only what was appended since the last successful run (byte-offset watermark, same
 *  mechanism as land-ct-discoveries.mjs): with CT tagging on, this file grows continuously, and
 *  re-reading + re-looking-up all of it every run is exactly what stalled the CT lander once.
 *
 *    node --env-file=.env.local scripts/land-cms-discoveries.mjs
 *    CMS_FROM_START=1 node … scripts/land-cms-discoveries.mjs     # ignore the watermark (full re-land)
 */
import postgres from "postgres";
import { readFileSync, writeFileSync, statSync } from "fs";
import { canonicalPlatform } from "../lib/platform-canon.ts";

const FINDS = process.env.CMS_FINDS || "/Users/joel/shopify-radar/feed/cms-discoveries.jsonl";
const OFFSET_FILE = process.env.CMS_OFFSET || FINDS + ".offset";
const today = () => new Date().toISOString().slice(0, 10);

function readOffset() {
  if (process.env.CMS_FROM_START === "1") return 0;
  try {
    const off = parseInt(readFileSync(OFFSET_FILE, "utf8").trim(), 10);
    if (!Number.isFinite(off) || off < 0) return 0;
    return off > statSync(FINDS).size ? 0 : off;   // file shrank (rotated) → start over
  } catch { return 0; }
}

async function main() {
  let text = "", endOffset = 0;
  try {
    const start = readOffset();
    endOffset = statSync(FINDS).size;
    // Bytes, not chars, so the watermark matches statSync().size even with multi-byte chars.
    text = readFileSync(FINDS).subarray(start, endOffset).toString("utf8");
    // A watermark always sits on a line boundary (we only ever store the file size we read up to,
    // and writers append whole lines), but a writer mid-append can leave a partial LAST line:
    // stop at the last newline and resume from there next run.
    const lastNl = text.lastIndexOf("\n");
    if (lastNl < 0) { console.log(`CMS discoveries: nothing new since byte ${start.toLocaleString()}.`); return; }
    endOffset = start + Buffer.byteLength(text.slice(0, lastNl + 1), "utf8");
    text = text.slice(0, lastNl + 1);
    console.log(`reading from byte ${start.toLocaleString()} of ${statSync(FINDS).size.toLocaleString()}`);
  } catch { console.log(`No CMS discoveries at ${FINDS} — nothing to land.`); return; }

  // domain -> { at, country, platform, source, certNotBefore } (earliest seen)
  const seen = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    const d = String(r.domain || "").trim().toLowerCase();
    const platform = canonicalPlatform(r.platform) ?? "";
    if (!d || !platform) continue;
    const at = (r.seen_at || "").slice(0, 10) || today();
    const country = r.country ? String(r.country).toUpperCase() : null;
    // Preserve the discovery source the feeder stamped (bulk_classify --source, e.g. common_crawl;
    // ct_tail's own tags are ct_hosted) so each feeder's yield is measurable.
    const source = (r.source && String(r.source).trim()) || "cms_dns";
    // TLS cert issuance date from the CT tailer (nullable). Recorded, but NOT used as a launch date
    // for hosted builders — unlike Shopify CT finds, nobody has measured how often it's a renewal.
    const certNotBefore = r.cert_not_before ? String(r.cert_not_before).slice(0, 10) : null;
    const prev = seen.get(d);
    if (!prev || at < prev.at) seen.set(d, { at, country, platform, source, certNotBefore });
  }
  if (!seen.size) {
    console.log("CMS discoveries: no new lines.");
    try { writeFileSync(OFFSET_FILE, String(endOffset)); } catch { /* best effort */ }
    return;
  }

  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3, idle_timeout: 20,
    connection: { statement_timeout: 240000, idle_in_transaction_session_timeout: 120000, lock_timeout: 8000 } });
  // Same retry-on-statement-timeout as land-ct-discoveries (pooler slot stuck behind probe writes).
  const withRetry = async (label, fn, tries = 4) => {
    for (let attempt = 1; ; attempt++) {
      try { return await fn(); }
      catch (e) {
        if (e?.code !== "57014" || attempt >= tries) throw e;
        console.log(`  ${label}: statement timeout (attempt ${attempt}/${tries}) — retrying`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  };
  try {
    const domains = [...seen.keys()];
    const existing = new Set();
    for (let i = 0; i < domains.length; i += 5000) {
      const slice = domains.slice(i, i + 5000);
      const rows = await withRetry(`lookup ${i}`, () => sql`SELECT domain FROM imported_stores WHERE domain = ANY(${slice})`);
      for (const r of rows) existing.add(r.domain);
    }
    const records = [...seen.entries()].map(([domain, { at, country, platform, source, certNotBefore }]) => ({
      domain, name: domain, country, discovered_at: at,
      published: false,               // banked — not surfaced until the platform is ready / promoted
      source, platform, cert_not_before: certNotBefore,
    }));
    const cols = ["domain", "name", "country", "discovered_at", "published", "source", "platform", "cert_not_before"];
    for (let i = 0; i < records.length; i += 400) {
      const batch = records.slice(i, i + 400);
      await withRetry(`upsert ${i}`, () => sql`
        INSERT INTO imported_stores ${sql(batch, ...cols)}
        ON CONFLICT (domain) DO UPDATE SET
          discovered_at   = COALESCE(imported_stores.discovered_at, EXCLUDED.discovered_at),
          platform        = COALESCE(imported_stores.platform, EXCLUDED.platform),
          cert_not_before = COALESCE(imported_stores.cert_not_before, EXCLUDED.cert_not_before)
        -- Skip no-op upserts: a known row whose fields are all set would still get a new row
        -- version (WAL + dead tuples) for nothing.
        WHERE imported_stores.discovered_at IS NULL
           OR imported_stores.platform IS NULL
           OR (imported_stores.cert_not_before IS NULL AND EXCLUDED.cert_not_before IS NOT NULL)`);
    }
    // Per-platform summary of what we just banked (new vs already-known).
    const fresh = domains.filter((d) => !existing.has(d));
    const byPlat = {};
    for (const [d, { platform }] of seen) {
      const k = platform + (existing.has(d) ? " (known)" : " (new)");
      byPlat[k] = (byPlat[k] || 0) + 1;
    }
    console.log(`CMS discoveries: ${seen.size} total · ${fresh.length} new · ${seen.size - fresh.length} already tracked`);
    console.log("  by platform:", JSON.stringify(byPlat));
    // Advance the watermark only after every write succeeded — a failed run re-reads the range.
    try { writeFileSync(OFFSET_FILE, String(endOffset)); } catch { /* best effort */ }
  } finally { await sql.end(); }
}

main().catch((e) => { console.error(e); process.exit(1); });
