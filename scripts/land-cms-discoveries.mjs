/** Land non-Shopify hosted-CMS discoveries (Wix, Squarespace, Odoo, BigCommerce, SFCC,
 *  Webflow, Cafe24, BASE) that bulk_classify.py detected by their DNS anchor.
 *
 *  These are BANKED, NOT SURFACED: inserted published=FALSE so they populate the /ops
 *  coverage "other" column and let us size each platform's footprint, WITHOUT entering
 *  insights / reports / the customer dashboard (those filter published=true) until we
 *  decide a platform is ready. Mirrors land-ct-discoveries.mjs, but for the banked CMS.
 *
 *  Never downgrades an existing row: on conflict it only backfills discovered_at and a
 *  NULL platform (COALESCE), so a confirmed Shopify/Woo/publish is never clobbered by a
 *  later DNS guess.
 *
 *    node --env-file=.env.local scripts/land-cms-discoveries.mjs
 */
import postgres from "postgres";
import { readFileSync } from "fs";

const FINDS = process.env.CMS_FINDS || "/Users/joel/shopify-radar/feed/cms-discoveries.jsonl";
const today = () => new Date().toISOString().slice(0, 10);

async function main() {
  let text = "";
  try { text = readFileSync(FINDS, "utf8"); }
  catch { console.log(`No CMS discoveries at ${FINDS} — nothing to land.`); return; }

  // domain -> { at, country, platform } (earliest seen; platform from the last non-empty)
  const seen = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    const d = String(r.domain || "").trim().toLowerCase();
    const platform = String(r.platform || "").trim();
    if (!d || !platform) continue;
    const at = (r.seen_at || "").slice(0, 10) || today();
    const country = r.country ? String(r.country).toUpperCase() : null;
    const prev = seen.get(d);
    if (!prev || at < prev.at) seen.set(d, { at, country, platform });
  }
  if (!seen.size) { console.log("CMS discoveries file empty — nothing to land."); return; }

  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3, idle_timeout: 20 });
  try {
    const existing = new Set(
      (await sql`SELECT domain FROM imported_stores WHERE domain = ANY(${[...seen.keys()]})`).map((r) => r.domain),
    );
    const records = [...seen.entries()].map(([domain, { at, country, platform }]) => ({
      domain, name: domain, country, discovered_at: at,
      published: false,               // banked — not surfaced until the platform is ready
      source: "cms_dns", platform,
    }));
    const cols = ["domain", "name", "country", "discovered_at", "published", "source", "platform"];
    for (let i = 0; i < records.length; i += 400) {
      const batch = records.slice(i, i + 400);
      await sql`
        INSERT INTO imported_stores ${sql(batch, ...cols)}
        ON CONFLICT (domain) DO UPDATE SET
          discovered_at = COALESCE(imported_stores.discovered_at, EXCLUDED.discovered_at),
          platform      = COALESCE(imported_stores.platform, EXCLUDED.platform)`;
    }
    // Per-platform summary of what we just banked (new vs already-known).
    const fresh = [...seen.keys()].filter((d) => !existing.has(d));
    const byPlat = {};
    for (const [d, { platform }] of seen) {
      const k = platform + (existing.has(d) ? " (known)" : " (new)");
      byPlat[k] = (byPlat[k] || 0) + 1;
    }
    console.log(`CMS discoveries: ${seen.size} total · ${fresh.length} new · ${seen.size - fresh.length} already tracked`);
    console.log("  by platform:", JSON.stringify(byPlat));
  } finally { await sql.end(); }
}

main().catch((e) => { console.error(e); process.exit(1); });
