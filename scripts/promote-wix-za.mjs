/** promote-wix-za — liveness-confirm the qualified ZA Wix STORES and publish the survivors.
 *
 *  wix-probe tags real Wix stores activity_tier='selling' but leaves them published=false (banked).
 *  Many were probed a while ago, so before surfacing them we re-fetch each homepage once to confirm
 *  it's still reachable AND still a Wix store (the store app id / markers). Reachable store →
 *  published=true + live_status='active' + live_checked_at=now. Unreachable → live_status='dead'
 *  (not published). Own-domain fetches, so no Shopify-edge rate limit.
 *
 *    node --env-file=.env.local scripts/promote-wix-za.mjs [--limit 2000] [--concurrency 8] [--dry-run]
 */
import postgres from "postgres";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const LIMIT = parseInt(arg("--limit", "2000"), 10);
const CONC = parseInt(arg("--concurrency", "8"), 10);
const DRY = process.argv.includes("--dry-run");
const UA = "Mozilla/5.0 (compatible; terrain-radar/1.0; +wix-promote)";
const WIX_STORES_APPID = "1380b703-ce81-ff05-f115-39571d94dfcd";
const STORE_MARKERS = [WIX_STORES_APPID, "wixstores", "addtocart", '"iscommerce"', "ecom-platform"];

async function get(url) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12000);
  try { return await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": UA } }); }
  catch { return null; } finally { clearTimeout(t); }
}
async function probe(domain) {
  let html = null;
  for (const u of [`https://${domain}/`, `https://www.${domain}/`]) {
    const r = await get(u);
    if (r && r.ok) { html = (await r.text().catch(() => "")).slice(0, 900_000); break; }
    if (r === null) break;
  }
  if (html == null) return { ok: false };
  const hay = html.toLowerCase();
  return { ok: true, isWix: hay.includes("wixstatic.com") || hay.includes("parastorage.com") || hay.includes("wix.com"), isStore: STORE_MARKERS.some((m) => hay.includes(m)) };
}
async function mapLimit(items, n, fn) {
  let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: Math.min(CONC + 1, 8), idle_timeout: 20 });
try {
  const rows = await sql`
    SELECT domain FROM imported_stores
    WHERE lower(platform)='wix' AND country='ZA' AND activity_tier='selling' AND NOT published
      AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
    ORDER BY estimated_monthly_sales DESC NULLS LAST LIMIT ${LIMIT}`;
  console.log(`promote-wix-za: ${rows.length} qualified ZA Wix stores to confirm (conc ${CONC})${DRY ? " [DRY]" : ""}`);
  let promoted = 0, stillStore = 0, notStore = 0, dead = 0;
  await mapLimit(rows, CONC, async ({ domain }) => {
    const r = await probe(domain);
    if (!r.ok) { dead++; if (!DRY) await sql`UPDATE imported_stores SET live_status='dead', live_checked_at=now() WHERE domain=${domain}`.catch(() => {}); return; }
    if (r.isStore) {
      stillStore++; promoted++;
      if (!DRY) await sql`UPDATE imported_stores SET published=true, live_status='active', live_checked_at=now(),
        first_verified_live_at=COALESCE(first_verified_live_at, now()) WHERE domain=${domain}`.catch(() => { promoted--; });
    } else {
      notStore++; // reachable but no store markers now — re-tag brochure, don't publish
      if (!DRY) await sql`UPDATE imported_stores SET activity_tier='not_a_store', live_status='active', live_checked_at=now() WHERE domain=${domain}`.catch(() => {});
    }
  });
  console.log(`confirmed stores ${stillStore} · now-brochure ${notStore} · unreachable→dead ${dead}`);
  console.log(`→ ${DRY ? "(dry) would publish" : "PUBLISHED"} ${promoted} ZA Wix stores`);
} finally { await sql.end(); }
