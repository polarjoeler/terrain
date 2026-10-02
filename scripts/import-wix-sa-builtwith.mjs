/** Import the BuiltWith "SA eCommerce — Wix" CSV into imported_stores.
 *
 *  BuiltWith export (Domain, Tech Spend, Vertical, …, Emails, Facebook, Instagram, City, Country,
 *  First Detected …). Detection dates are 2016–2019, so this is HISTORICAL: we land every row
 *  published=false (banked, per the bulk-import rule — never surface unconfirmed stores in insights),
 *  tag platform=Wix, set discovered_at from First Detected so it doesn't inflate new-discovery
 *  metrics, and COALESCE enrichment so we never clobber fresher data on the ~349 rows already present.
 *  Liveness + store-vs-brochure qualification is a separate pass (scripts/wix-probe.mjs), which is
 *  what actually promotes the real stores.
 *
 *    node --env-file=.env.local scripts/import-wix-sa-builtwith.mjs --csv "<path>" [--dry-run]
 */
import postgres from "postgres";
import { readFileSync } from "fs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const CSV = arg("--csv", "");
const DRY = process.argv.includes("--dry-run");
if (!CSV) { console.error("--csv required"); process.exit(1); }

// Minimal RFC4180 CSV parser (handles quoted fields + embedded commas/quotes).
function parseCsv(text) {
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const cleanDomain = (d) => { d = (d || "").trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].trim(); return d && d.includes(".") && !d.includes(" ") ? d : null; };
const firstEmail = (s) => { const m = (s || "").match(/[\w.+-]+@[\w-]+\.[\w.-]+/); return m ? m[0].toLowerCase() : null; };
const handle = (url) => { const m = (url || "").match(/(?:facebook|instagram)\.com\/([^/?#]+)/i); return m ? m[1] : null; };
const parseDate = (s) => { const m = (s || "").match(/(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };

const raw = parseCsv(readFileSync(CSV, "utf8"));
// Header is the first row whose first cell is "Domain"; data follows.
const hIdx = raw.findIndex((r) => (r[0] || "").trim().toLowerCase() === "domain");
if (hIdx < 0) { console.error("no header row with 'Domain'"); process.exit(1); }
const data = raw.slice(hIdx + 1);
// Column positions from the header.
const H = raw[hIdx].map((c) => (c || "").trim().toLowerCase());
const col = (name) => H.indexOf(name);
const ci = { domain: col("domain"), vertical: col("vertical"), emails: col("emails"), facebook: col("facebook"), instagram: col("instagram"), city: col("city"), first: col("first detected") };

const recs = [];
const seen = new Set();
for (const r of data) {
  const domain = cleanDomain(r[ci.domain]);
  if (!domain || seen.has(domain)) continue;
  seen.add(domain);
  recs.push({
    domain,
    category: (r[ci.vertical] || "").trim() || null,
    email: firstEmail(r[ci.emails]),
    facebook: handle(r[ci.facebook]),
    instagram: handle(r[ci.instagram]),
    city: (r[ci.city] || "").trim() || null,
    discovered_at: parseDate(r[ci.first]),
  });
}
console.log(`parsed ${recs.length} unique domains from CSV`);
if (DRY) { console.log("sample:", recs.slice(0, 3)); process.exit(0); }

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 2 });
const SOURCE = "builtwith_wix_za_2019";
const TAG = "wix-sa-2019";
await sql`CREATE TABLE IF NOT EXISTS store_tags (domain text, tag text, PRIMARY KEY (domain, tag))`;

let inserted = 0, updated = 0;
for (const x of recs) {
  // published is NOT set on conflict — banked rows stay banked; new rows land published=false.
  const [res] = await sql`
    INSERT INTO imported_stores (domain, country, category, city, email, instagram, facebook, platform, source, discovered_at, first_seen, published)
    VALUES (${x.domain}, 'ZA', ${x.category}, ${x.city}, ${x.email}, ${x.instagram}, ${x.facebook}, 'Wix', ${SOURCE}, ${x.discovered_at}, ${x.discovered_at}, false)
    ON CONFLICT (domain) DO UPDATE SET
      category  = COALESCE(imported_stores.category, EXCLUDED.category),
      city      = COALESCE(imported_stores.city, EXCLUDED.city),
      email     = COALESCE(imported_stores.email, EXCLUDED.email),
      instagram = COALESCE(imported_stores.instagram, EXCLUDED.instagram),
      facebook  = COALESCE(imported_stores.facebook, EXCLUDED.facebook),
      platform  = COALESCE(imported_stores.platform, EXCLUDED.platform)
    RETURNING (xmax = 0) AS is_new`;
  if (res.is_new) inserted++; else updated++;
  await sql`INSERT INTO store_tags (domain, tag) VALUES (${x.domain}, ${TAG}) ON CONFLICT DO NOTHING`;
}
console.log(`done — inserted ${inserted} new, updated ${updated} existing (enriched, published untouched)`);
await sql.end();
