/** Land CT-tailer discoveries into imported_stores.
 *
 *  ~/shopify-radar/ct_tail.py tails the CT logs directly (no crt.sh) and appends
 *  every .za domain it confirms resolves to Shopify to feed/ct-discoveries.jsonl.
 *  This lands them: brand-new domains are inserted (source=ct_tail, published), and
 *  domains we already track just get discovered_at backfilled — never overwritten.
 *
 *  The overlap it prints IS the recall signal: of the stores the CT tail found, how
 *  many did our (crt.sh-based) pipeline already have vs. how many are genuinely new?
 *  Lots of "new" = crt.sh was missing them = our recall was lower than we thought.
 *
 *    node --env-file=.env.local scripts/land-ct-discoveries.mjs
 */
import postgres from "postgres";
import { readFileSync, writeFileSync, statSync } from "fs";

const FINDS = process.env.CT_FINDS || "/Users/joel/shopify-radar/feed/ct-discoveries.jsonl";
// Byte-offset watermark. ct-discoveries.jsonl is append-only, but the script re-read
// ALL of it every 30 minutes — 293,863 lines / 201,133 unique domains — and looked
// every one up in the DB. That work grew daily until a run could no longer finish
// inside the 2-minute statement timeout, at which point landing stopped entirely and
// discovery read as 0 while ct_tail kept finding stores. Reading only what is new
// since the last successful run cuts the work by ~99%.
// Reset to 0 if the file shrank (rotated/truncated), so nothing is silently skipped.
const OFFSET_FILE = process.env.CT_OFFSET || FINDS + ".offset";
function readOffset() {
  try {
    const off = parseInt(readFileSync(OFFSET_FILE, "utf8").trim(), 10);
    if (!Number.isFinite(off) || off < 0) return 0;
    return off > statSync(FINDS).size ? 0 : off;
  } catch { return 0; }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// TLDs that are ccTLDs but used generically → don't infer a country.
const GENERIC = new Set(["io", "co", "me", "tv", "cc", "ai", "gg", "sh", "to", "ly", "fm", "us",
  "com", "net", "org", "shop", "store", "xyz", "app", "dev", "biz", "info", "online", "site"]);
function countryFromDomain(d) {
  const tld = String(d).toLowerCase().split(".").pop();
  return tld && tld.length === 2 && !GENERIC.has(tld) ? tld.toUpperCase() : null;
}

async function main() {
  let text = "";
  try {
    const startOffset = readOffset();
    const fullSize = statSync(FINDS).size;
    // Slice from the watermark. Read as a Buffer so the offset is in BYTES, matching
    // statSync().size — slicing a decoded string would drift on any multi-byte char.
    text = readFileSync(FINDS).subarray(startOffset, fullSize).toString("utf8");
    if (startOffset) text = text.slice(text.indexOf("\n") + 1);   // drop a partial first line
    console.log(`reading from byte ${startOffset.toLocaleString()} of ${fullSize.toLocaleString()} (${((1 - startOffset / fullSize) * 100).toFixed(1)}% new)`);
    globalThis.__ctNewOffset = fullSize;
  } catch {
    console.log(`No CT discoveries file at ${FINDS} yet — nothing to land.`);
    return;
  }

  // domain -> { at: earliest seen date, country }
  const seen = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      const d = String(r.domain || "").trim().toLowerCase();
      if (!d) continue;
      const at = (r.seen_at || "").slice(0, 10) || today();
      // Prefer the recorded country; else derive from the ccTLD; else null (generic TLD).
      const country = (r.country ? String(r.country).toUpperCase() : null) || countryFromDomain(d);
      // TLS cert issuance date (ISO YYYY-MM-DD) captured by the CT tailer; may be absent/null.
      // NOT a launch date — a cert renewal has a fresh notBefore, so it never touches launched_at.
      const certNotBefore = r.cert_not_before ? String(r.cert_not_before).slice(0, 10) : null;
      const prev = seen.get(d);
      if (!prev || at < prev.at) seen.set(d, { at, country, certNotBefore });
    } catch {
      /* skip malformed line */
    }
  }
  if (!seen.size) {
    console.log("CT discoveries file is empty — nothing to land.");
    return;
  }

  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3, idle_timeout: 20 });

  // Retry on statement timeout. The queries themselves run in ~1s, but the first
  // statement on a pooled connection intermittently blocks ~57s behind the probe
  // write load and trips the 2-minute server timeout. Retrying picks up a different
  // pooler slot and usually succeeds immediately. `SET statement_timeout` is not an
  // option here: the Supabase pooler runs in transaction mode, so a SET does not
  // survive past the transaction that issued it.
  const withRetry = async (label, fn, tries = 4) => {
    for (let attempt = 1; ; attempt++) {
      try { return await fn(); }
      catch (e) {
        const timedOut = e?.code === "57014";
        if (!timedOut || attempt >= tries) throw e;
        const wait = 2000 * attempt;
        console.log(`  ${label}: statement timeout (attempt ${attempt}/${tries}) — retrying in ${wait / 1000}s`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  };
  try {
    // Nullable cert-issuance date column. Check the catalog FIRST, then ALTER only if
    // missing. `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` is idempotent but NOT lock-free:
    // it takes an ACCESS EXCLUSIVE lock even when the column already exists. With the
    // probes writing to imported_stores around the clock it could never get that lock,
    // so every 30-minute run died here on the 2-minute statement timeout and landed
    // nothing — discovery read as 0 for 10+ hours while ct_tail kept finding stores.
    const [hasCol] = await sql`SELECT 1 FROM information_schema.columns
      WHERE table_name = 'imported_stores' AND column_name = 'cert_not_before'`;
    if (!hasCol) await sql`ALTER TABLE imported_stores ADD COLUMN cert_not_before date`;
    // Chunked. This was ONE `domain = ANY($1)` over every domain in the seen-file —
    // fine at a few thousand, fatal at 201,133: the query exceeded even the 2-minute
    // statement_timeout, so landing failed on every 30-minute run and 14,183
    // discoveries sat unlandable while ct_tail kept finding more. The file is
    // append-only, so this got slower daily until it crossed the limit.
    const domains = [...seen.keys()];
    const existing = new Set();
    for (let i = 0; i < domains.length; i += 5000) {
      const slice = domains.slice(i, i + 5000);
      const rows = await withRetry(`lookup ${i}-${i + slice.length}`,
        () => sql`SELECT domain FROM imported_stores WHERE domain = ANY(${slice})`);
      for (const r of rows) existing.add(r.domain);
    }
    const fresh = [...seen.keys()].filter((d) => !existing.has(d));

    const records = [...seen.entries()].map(([domain, { at, country, certNotBefore }]) => ({
      domain,
      name: domain,
      country,
      discovered_at: at,
      published: true,
      source: "ct_tail",
      // ct_tail only surfaces Shopify (it tails Shopify CT certs), so the platform is known at
      // landing. Stamping it here means fresh leads are classified the instant they land — no
      // waiting on a probe — so insights counts + the "new this week" tile are honest immediately.
      platform: "Shopify",
      // TLS cert issuance date (nullable). Freshness signal only — deliberately NOT launched_at.
      cert_not_before: certNotBefore,
    }));
    const cols = ["domain", "name", "country", "discovered_at", "published", "source", "platform", "cert_not_before"];
    for (let i = 0; i < records.length; i += 400) {
      const batch = records.slice(i, i + 400);
      // Insert new; for existing, only backfill discovered_at + platform-if-unset + cert_not_before-if-unset
      // (never touch source / published / an already-classified platform / launched_at — those stay put).
      await withRetry(`upsert ${i}-${i + batch.length}`, () => sql`
        INSERT INTO imported_stores ${sql(batch, ...cols)}
        ON CONFLICT (domain) DO UPDATE SET
          discovered_at   = COALESCE(imported_stores.discovered_at, EXCLUDED.discovered_at),
          platform        = COALESCE(imported_stores.platform, EXCLUDED.platform),
          cert_not_before = COALESCE(imported_stores.cert_not_before, EXCLUDED.cert_not_before)
        -- Only write when a COALESCE would actually change something. Without this the
        -- run re-upserted all 201,133 rows every 30 minutes (~9.6M/day) where the
        -- COALESCEs were no-ops — Postgres still writes a new row version per upsert,
        -- so it was pure write amplification: WAL, dead tuples and autovacuum load on
        -- an already CPU-starved instance, for no change.
        WHERE imported_stores.discovered_at IS NULL
           OR imported_stores.platform IS NULL
           OR imported_stores.cert_not_before IS NULL`);
    }

    const overlap = seen.size - fresh.length;
    const recallPct = seen.size ? ((overlap / seen.size) * 100).toFixed(0) : "—";
    console.log(`CT-tail discoveries: ${seen.size} total`);
    console.log(`  already tracked (overlap): ${overlap} (${recallPct}%)`);
    console.log(`  NEW (crt.sh had missed):   ${fresh.length}`);
    if (fresh.length) console.log("  sample new:", fresh.slice(0, 12).join(", "));
    console.log(`\n→ recall read: of stores the independent CT tail saw, we already had ${recallPct}%.`);
    // Only advance the watermark after everything above succeeded — a failed run must
    // re-read the same range next time rather than skipping it.
    try { writeFileSync(OFFSET_FILE, String(globalThis.__ctNewOffset ?? 0)); } catch { /* best effort */ }
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
