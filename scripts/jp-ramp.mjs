/** jp-ramp — Japan demo prep. Verify the banked JP-native CMS stores (BASE / Cafe24 / EC-CUBE /
 *  Wix / SFCC / Squarespace / Webflow) and PUBLISH the live ones, so Japan's real platforms show
 *  up in the demo — without publishing dead BuiltWith imports (we confirm liveness first).
 *
 *  Liveness-gated: one homepage GET each (own domains — no Shopify-edge budget). HTTP 200 →
 *  publish + live_status='active'; anything else → live_status='dead', left unpublished. Dating
 *  is a separate cert-launch pass (these become eligible once published).
 *
 *    node --env-file=.env.local scripts/jp-ramp.mjs [--dry-run]
 */
import postgres from "postgres";
const DRY = process.argv.includes("--dry-run");
const UA = "Mozilla/5.0 (compatible; terrain-radar/1.0; +jp-ramp)";
const CMS = ["BASE", "Cafe24", "EC-CUBE", "Wix", "Salesforce Commerce Cloud", "Squarespace", "Webflow", "PrestaShop", "Odoo"];

async function get(url) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 12000);
  try { return await fetch(url, { signal: c.signal, redirect: "follow", headers: { "User-Agent": UA } }); }
  catch { return null; } finally { clearTimeout(t); }
}
async function mapLimit(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); })); }

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 4, idle_timeout: 20 });
  try {
    const rows = await sql`SELECT domain, platform FROM imported_stores
      WHERE UPPER(country)='JP' AND platform = ANY(${CMS}) AND NOT published
        AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))`;
    console.log(`jp-ramp: verifying ${rows.length} banked JP-native CMS stores${DRY ? " [DRY]" : ""}`);
    let live = 0, dead = 0; const byPlat = {};
    await mapLimit(rows, 10, async ({ domain, platform }) => {
      let ok = false;
      for (const u of [`https://${domain}/`, `https://www.${domain}/`]) {
        const r = await get(u); if (r && r.ok) { ok = true; break; } if (r === null) break;
      }
      if (ok) { live++; byPlat[platform] = (byPlat[platform] || 0) + 1; } else dead++;
      if (!DRY) {
        await sql`UPDATE imported_stores SET
          live_status = ${ok ? "active" : "dead"}, live_checked_at = now(),
          published = ${ok ? true : sql`published`}
          WHERE domain = ${domain}`.catch(() => {});
      }
    });
    console.log(`published (live): ${live} · dead/unreachable: ${dead}`);
    console.log("published by platform:", JSON.stringify(byPlat));
    if (!DRY && live) console.log("→ run cert-launch --country JP next to date them.");
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
