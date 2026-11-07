/** backfill-shop-meta — fetch /meta.json for stores we already probed.
 *
 *  The checkout probe now banks shop identity, but it skips stores it has already done, so the
 *  existing base would only get it via a --force re-probe (5 requests/store). This is one
 *  request per store for the same payload:
 *    · shop_country/city/province — Shopify's OWN answer, ground truth against the ccTLD+currency
 *      guess that mislabels international stores as local;
 *    · shop_id — the real identity behind www/apex and generic-TLD rows that look like separate
 *      stores (and so the key for measuring how inflated the counts actually are);
 *    · myshopify_domain — the canonical handle.
 *
 *  STRICTLY SEQUENTIAL. Every store probe on this box shares one residential IP's Shopify-edge
 *  rate budget; concurrency here would 429 the pipeline, not just this script.
 *
 *    node --env-file=.env.local scripts/backfill-shop-meta.mjs --limit 500 [--delay 1200]
 *                                                              [--country ZA] [--dry]
 */
import postgres from "postgres";

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : d;
};
const LIMIT = Number(arg("limit", 500));
const DELAY = Number(arg("delay", 2500));
const COUNTRY = arg("country", null);
const DRY = process.argv.includes("--dry");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function metaOnce(host) {
  try {
    const r = await fetch(`https://${host}/meta.json`, {
      redirect: "follow", signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (r.status === 429) return { miss: "blocked_429", throttled: true };
    if (r.status === 403) return { miss: "blocked_403" };
    if (!r.ok) return { miss: `http_${r.status}` };
    if (!(r.headers.get("content-type") || "").toLowerCase().includes("json")) {
      return { miss: "html_at_meta" }; // 200 but not Shopify's endpoint — migrated off
    }
    const d = await r.json();
    return d && typeof d === "object" && d.id ? { shop: d } : { miss: "json_no_id" };
  } catch (e) {
    return { miss: e?.name === "TimeoutError" ? "timeout" : "unreachable" };
  }
}
// a www. host can hard-404 meta.json while the apex serves it; the retry only costs a
// request on a host that already failed.
async function getMeta(domain) {
  const first = await metaOnce(domain);
  if (first.shop || !/^www\./i.test(domain)) return first;
  const apex = await metaOnce(domain.slice(4));
  return apex.shop ? apex : first; // report the www host's own reason when neither answers
}

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3, idle_timeout: 20 });
try {
  if (!DRY) {
    await sql`SET lock_timeout = '4s'`;
    for (const [col, type] of [["shop_id", "BIGINT"], ["shop_country", "TEXT"], ["shop_city", "TEXT"],
      ["shop_province", "TEXT"], ["shop_currency", "TEXT"], ["myshopify_domain", "TEXT"]]) {
      await sql.unsafe(`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS ${col} ${type}`);
    }
    await sql`CREATE INDEX IF NOT EXISTS idx_imported_shop_id ON imported_stores (shop_id)`;
  }
  const hasCol = await sql`
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_name='imported_stores' AND column_name='shop_id') AS has`;
  // --dry has to work BEFORE the migration, so skip the shop_id filter when the column
  // isn't there yet (every probed store is a target at that point anyway).
  const pending = hasCol[0].has ? sql`AND shop_id IS NULL` : sql``;
  if (!hasCol[0].has && !DRY) { console.log("shop_id column missing after migration — aborting."); process.exit(1); }

  // biggest first: the identity of a high-revenue store is worth more than a long-tail one
  const targets = await sql`
    SELECT domain, country FROM imported_stores
    WHERE published AND lower(platform) = 'shopify' ${pending}
      AND payments_checked_at IS NOT NULL
      ${COUNTRY ? sql`AND country = ${COUNTRY}` : sql``}
    ORDER BY estimated_monthly_sales DESC NULLS LAST
    LIMIT ${LIMIT}`;
  console.log(`${targets.length} target(s)${COUNTRY ? ` in ${COUNTRY}` : ""}, ${DELAY}ms apart `
    + `(~${Math.round(targets.length * DELAY / 60000)} min)${DRY ? " — DRY RUN" : ""}\n`);
  if (DRY) { targets.slice(0, 20).forEach((t) => console.log(`  ${t.domain}`)); process.exit(0); }

  let hit = 0, disagree = 0;
  const misses = {};
  const BACKOFF = [30_000, 90_000, 240_000]; // every store probe on this box shares one IP
  for (const t of targets) {
    let r = await getMeta(t.domain);
    // ride out a throttle before believing it; a 429 says nothing about this store
    for (let i = 0; r.throttled && i < BACKOFF.length; i++) {
      console.log(`  429 — backing off ${BACKOFF[i] / 1000}s`);
      await sleep(BACKOFF[i]);
      r = await getMeta(t.domain);
    }
    if (r.throttled) {
      // still throttled after ~6 min of waiting: the budget is gone. Stopping is the only
      // useful move — carrying on marks live stores as unanswerable and starves the probes
      // that share the IP.
      console.log(`\nSTOPPING: still 429 after backoff. ${hit} identified before the budget ran out.`);
      misses.blocked_429 = (misses.blocked_429 || 0) + 1;
      break;
    }
    const m = r.shop;
    if (!m) {
      misses[r.miss] = (misses[r.miss] || 0) + 1;
      await sleep(DELAY); continue;
    }
    hit++;
    if (m.country && t.country && m.country.toUpperCase() !== t.country.toUpperCase()) {
      disagree++;
      console.log(`  country: ${t.domain} had ${t.country} -> Shopify says ${m.country}`);
    }
    await sql`
      UPDATE imported_stores SET
        shop_id          = ${Number(m.id) || null}::bigint,
        shop_country     = COALESCE(${m.country || null}::text, shop_country),
        shop_city        = COALESCE(${m.city || null}::text, shop_city),
        shop_province    = COALESCE(${m.province || null}::text, shop_province),
        shop_currency    = COALESCE(${m.currency || null}::text, shop_currency),
        myshopify_domain = COALESCE(${m.myshopify_domain || null}::text, myshopify_domain)
      WHERE domain = ${t.domain}`;
    await sleep(DELAY);
  }
  const missTotal = Object.values(misses).reduce((a, b) => a + b, 0);
  console.log(`\nidentified ${hit}, no answer ${missTotal}. Country disagreements: ${disagree}.`);
  if (missTotal) {
    // http_404 / html_at_meta => the domain is not a live Shopify storefront any more, which is
    // a churn signal. blocked_403 is NOT: the store may be fine behind a bot-blocker.
    console.log("why no answer:"); console.table(misses);
  }
  const [dupes] = await sql`
    SELECT count(*)::int AS shops, COALESCE(sum(n) - count(*), 0)::int AS surplus_rows FROM (
      SELECT shop_id, count(*) n FROM imported_stores
      WHERE published AND shop_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1) q`;
  console.log(`shop_ids answering on >1 domain row: ${dupes.shops} (${dupes.surplus_rows} surplus rows).`);
} finally { await sql.end(); }
