#!/usr/bin/env node
// Selar merchant-storefront ingester — the discovery lane for a PATH-BASED social-commerce
// platform that CT/DNS/fingerprinting can't see.
//
// Selar stores live at selar.com/m/<slug> — no own domain, no own TLS cert — so the only way to
// enumerate them is Selar's own merchant sitemap. selar.com/sitemap.xml fans out to
// ~90 sitemap_merchants_N files, ~3,000 stores each (~270k total), each <url> carrying a <lastmod>
// (the store's last-update time — a real activity signal, 2022…2025).
//
// We key each store on its full URL as `domain` (selar.com/m/<slug>, platform='Selar') since there
// is no hostname of its own; land published=false (banked) — promote-confirmed (which now lists
// 'selar') publishes the live ones. Default gate: lastmod >= --since (keeps the hot DB lean; a
// dormant 2022 creator page is not a sellable lead). ON CONFLICT(domain) DO NOTHING = safe re-runs.
//
// LIVENESS: every Selar store lives on ONE host (selar.com), so HTTP-crawling 270k of them would
// hammer a single server — unlike own-domain crawls that spread over thousands of hosts. So the
// primary liveness signal is the sitemap's own <lastmod> (Selar's "last updated this store" time),
// stored in last_alive_at — free, zero load. A paced HTTP confirmation is a separate, gentle pass.
//
// Run:  node --env-file=.env.local scripts/ingest-selar.mjs              # land active stores (since 2024-01-01)
//       node --env-file=.env.local scripts/ingest-selar.mjs --dry        # counts + lastmod histogram, no writes
//       node --env-file=.env.local scripts/ingest-selar.mjs --since 2023-01-01 --limit 5000
import postgres from "postgres";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const DRY = process.argv.includes("--dry");
const SINCE = arg("--since", "2024-01-01");                 // lastmod floor
const LIMIT = Number(arg("--limit", "0")) || Infinity;      // cap stores (testing)
const MAX_SITEMAPS = Number(arg("--sitemaps", "0")) || Infinity;
const INDEX = "https://selar.com/sitemap.xml";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

async function get(url, timeoutMs = 25000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: ac.signal });
    if (!r.ok) { console.error(`  ! ${url} → HTTP ${r.status}`); return null; }
    return await r.text();
  } catch (e) { console.error(`  ! ${url} → ${e.message}`); return null; }
  finally { clearTimeout(t); }
}

const locs = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
// pair each <loc> with the <lastmod> that follows it in the same <url> block
function urlEntries(xml) {
  const out = [];
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const block = m[1];
    const loc = block.match(/<loc>([^<]+)<\/loc>/)?.[1]?.trim();
    const lastmod = block.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1]?.trim() ?? null;
    if (loc) out.push({ loc, lastmod });
  }
  return out;
}

async function main() {
  console.log(`ingest-selar${DRY ? " [DRY]" : ""} · lastmod >= ${SINCE}${LIMIT !== Infinity ? ` · limit ${LIMIT}` : ""}`);
  const idx = await get(INDEX);
  if (!idx) { console.error("could not fetch sitemap index"); process.exitCode = 1; return; }
  const merchantMaps = locs(idx).filter((u) => /sitemap_merchants_\d+/.test(u)).slice(0, MAX_SITEMAPS);
  console.log(`merchant sitemaps: ${merchantMaps.length}`);

  const seen = new Map();          // domain -> { name, lastmod }
  const yearHist = {};             // lastmod year -> count (all, pre-gate)
  const sinceDate = new Date(SINCE);
  let scanned = 0;

  for (let i = 0; i < merchantMaps.length; i++) {
    const xml = await get(merchantMaps[i]);
    if (!xml) continue;
    for (const { loc, lastmod } of urlEntries(xml)) {
      const slug = loc.match(/selar\.com\/m\/([^/?#]+)/i)?.[1];
      if (!slug) continue;
      scanned++;
      const yr = lastmod ? lastmod.slice(0, 4) : "none";
      yearHist[yr] = (yearHist[yr] ?? 0) + 1;
      if (lastmod && new Date(lastmod) < sinceDate) continue;      // activity gate
      const domain = `selar.com/m/${slug}`;
      if (!seen.has(domain) && seen.size < LIMIT) seen.set(domain, { name: slug, lastmod });
    }
    if ((i + 1) % 10 === 0) console.log(`  …${i + 1}/${merchantMaps.length} sitemaps · ${scanned.toLocaleString()} scanned · ${seen.size.toLocaleString()} in-gate`);
    if (seen.size >= LIMIT) break;
  }

  console.log(`\nscanned ${scanned.toLocaleString()} stores; ${seen.size.toLocaleString()} pass the lastmod gate (>= ${SINCE}).`);
  console.log("lastmod by year (all, pre-gate):", Object.fromEntries(Object.entries(yearHist).sort()));

  if (DRY) { console.log("[DRY] no writes."); return; }
  if (!seen.size) { console.log("nothing to land."); return; }

  const sql = postgres(process.env.DATABASE_URL || process.env.POSTGRES_URL, { ssl: "require", max: 2 });
  try {
    const rows = [...seen.entries()].map(([domain, v]) => ({
      domain, name: v.name, platform: "Selar", published: false,
      source: "selar_sitemap", country: null, discovered_at: new Date().toISOString(),
      // sitemap <lastmod> = Selar's "last updated this store" time → our free liveness/activity signal.
      last_alive_at: v.lastmod ? new Date(v.lastmod).toISOString() : null,
    }));
    const cols = ["domain", "name", "platform", "published", "source", "country", "discovered_at", "last_alive_at"];
    let landed = 0;
    for (let i = 0; i < rows.length; i += 1000) {
      const batch = rows.slice(i, i + 1000);
      const res = await sql`INSERT INTO imported_stores ${sql(batch, ...cols)} ON CONFLICT (domain) DO NOTHING`;
      landed += res.count;
      if ((i / 1000) % 10 === 0) console.log(`  …${Math.min(i + 1000, rows.length).toLocaleString()}/${rows.length.toLocaleString()}`);
    }
    console.log(`landed ${landed.toLocaleString()} NEW Selar stores (ON CONFLICT skipped existing).`);
  } catch (e) { console.error("ERR", e.message); process.exitCode = 1; }
  finally { await sql.end(); }
}
main();
