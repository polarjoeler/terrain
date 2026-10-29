#!/usr/bin/env node
// Paystack Storefront ingester — lands path-based stores discovered via search enumeration.
//
// Paystack Storefronts live at paystack.shop/<slug> (Next.js SPA, no custom domains, no usable
// sitemap), so they're invisible to CT/DNS. The discovery surface is SEARCH: domain-restricted
// queries (site:paystack.shop / Instagram bios) surface the indexed store pages cheaply. This takes
// a harvested list of those URLs/slugs and banks each store (published=false). Paystack Storefront
// is enabled only in NG/GH/ZA, so every store is African by construction (exact country comes from
// a later currency pass, like selar-enrich).
//
// Run:  node --env-file=.env.local scripts/ingest-paystack.mjs --from-file <urls.txt>
import postgres from "postgres";
import fs from "fs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const DRY = process.argv.includes("--dry");
const FILE = arg("--from-file", "");
if (!FILE) { console.error("need --from-file <paystack urls/slugs, one per line>"); process.exit(2); }

// System/non-store slugs to skip (Paystack's own pages, one-off payment links).
const SKIP = new Set(["", "pay", "terminal-storefront"]);

function slugOf(line) {
  let s = line.trim();
  if (!s || s.startsWith("#")) return null;
  s = s.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  if (s.startsWith("paystack.shop/")) s = s.slice("paystack.shop/".length);
  s = s.split("?")[0].split("#")[0].replace(/\/+$/, "").trim();   // drop ?product=…, fragments, trailing /
  if (!s || s.includes("/") || SKIP.has(s.toLowerCase())) return null; // first path segment only; skip /pay/…
  return s;
}

async function main() {
  const slugs = [...new Set(fs.readFileSync(FILE, "utf8").split("\n").map(slugOf).filter(Boolean))];
  console.log(`ingest-paystack${DRY ? " [DRY]" : ""}: ${slugs.length} unique storefront(s) from ${FILE}`);
  if (DRY) { slugs.slice(0, 20).forEach((s) => console.log("  paystack.shop/" + s)); console.log("[DRY] no writes."); return; }
  if (!slugs.length) { console.log("nothing to land."); return; }

  const sql = postgres(process.env.DATABASE_URL || process.env.POSTGRES_URL, { ssl: "require", max: 2 });
  try {
    const rows = slugs.map((s) => ({
      domain: `paystack.shop/${s}`, name: s, platform: "Paystack Storefront", published: false,
      source: "paystack_search", country: null, discovered_at: new Date().toISOString(),
    }));
    const cols = ["domain", "name", "platform", "published", "source", "country", "discovered_at"];
    let landed = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const res = await sql`INSERT INTO imported_stores ${sql(rows.slice(i, i + 500), ...cols)} ON CONFLICT (domain) DO NOTHING`;
      landed += res.count;
    }
    console.log(`landed ${landed} NEW Paystack storefront(s) (ON CONFLICT skipped existing).`);
  } catch (e) { console.error("ERR", e.message); process.exitCode = 1; }
  finally { await sql.end(); }
}
main();
