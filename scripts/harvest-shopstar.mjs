#!/usr/bin/env node
// ShopStar reverse-IP harvester. Every ShopStar store (free-tier *.shopstar.co.za subdomains AND
// paid custom domains) A-records to two shared xneelo app IPs. Reverse-IP on those anchors
// enumerates the whole fleet — far more complete than search, and HackerTarget's reverse-IP API is
// free + keyless. Land them banked (platform=ShopStar, country=ZA — ShopStar is a ZA platform);
// the HTTP fingerprint lane (shopstar.co.za / _tillyoudrop_session) re-confirms custom domains, and
// ON CONFLICT never clobbers a store we already track.
//
// Run:  node --env-file=.env.local scripts/harvest-shopstar.mjs --dry   # fetch + count, no writes
//       node --env-file=.env.local scripts/harvest-shopstar.mjs
import postgres from "postgres";

const DRY = process.argv.includes("--dry");
const ANCHORS = ["156.38.138.234", "156.38.136.250"];
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// Infra / non-store hostnames the shared xneelo IP returns (mail, autodiscovery, nameservers…).
const NOISE = /^(autodiscover|api-mailer|mail|webmail|smtp|imap|pop|cpanel|whm|ftp|ns\d?|mx\d?|_|cpcalendars|cpcontacts)\./;
function cleanDomain(raw) {
  const d = (raw || "").trim().toLowerCase();
  if (!d || d.includes(" ") || !d.includes(".") || d.startsWith("*")) return null;
  if (/[^a-z0-9.-]/.test(d)) return null;              // drop API error lines ("error check…", "API count…")
  if (NOISE.test(d)) return null;
  if (/^(app|www)?\.?shopstar\.co\.za$/.test(d) || d === "shopstar.co.za") return null; // ShopStar's own infra
  return d;
}

// A ShopStar store page carries the platform's asset host / cart cookie needle. Custom domains on
// the shared xneelo IP must pass this before we label them ShopStar (the IP alone isn't proof).
async function isShopStar(domain) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 14000);
  try {
    const r = await fetch(`https://${domain}`, { headers: { "User-Agent": UA }, redirect: "follow", signal: ac.signal });
    if (r.status !== 200) return false;
    const b = await r.text();
    return /shopstar\.co\.za|shopstar-assets|_tillyoudrop_session/i.test(b);
  } catch { return false; } finally { clearTimeout(t); }
}

async function main() {
  console.log(`harvest-shopstar${DRY ? " [DRY]" : ""} · reverse-IP on ${ANCHORS.length} xneelo anchors`);
  const seen = new Set();
  for (const ip of ANCHORS) {
    const r = await fetch(`https://api.hackertarget.com/reverseiplookup/?q=${ip}`, { headers: { "User-Agent": UA } }).catch(() => null);
    const txt = r ? await r.text() : "";
    if (/API count exceeded|error|no records|too many/i.test(txt) && !txt.includes(".")) { console.error(`  ! ${ip}: ${txt.slice(0, 80)}`); continue; }
    const doms = txt.split("\n").map(cleanDomain).filter(Boolean);
    doms.forEach((d) => seen.add(d));
    console.log(`  ${ip}: ${doms.length} domains`);
  }
  // Subdomains are definitely ShopStar; custom domains must be HTTP-confirmed (shared IP).
  const subs = [...seen].filter((d) => d.endsWith(".shopstar.co.za"));
  const customs = [...seen].filter((d) => !d.endsWith(".shopstar.co.za"));
  console.log(`total unique: ${seen.size} · subdomains (confident): ${subs.length} · custom (need HTTP-confirm): ${customs.length}`);
  if (DRY) { subs.slice(0, 10).forEach((d) => console.log("  sub  " + d)); customs.slice(0, 10).forEach((d) => console.log("  cust " + d)); console.log("[DRY] no writes, no confirm fetches."); return; }
  if (!seen.size) { console.log("nothing to land (reverse-IP returned nothing — likely rate-limited; retry later)."); return; }

  // HTTP-confirm customs, paced (conc 4, 300ms — they share the xneelo host).
  const confirmed = [...subs];
  let ci = 0, hit = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (ci < customs.length) {
      const d = customs[ci++];
      if (await isShopStar(d)) { confirmed.push(d); hit++; }
      await new Promise((r) => setTimeout(r, 300));
    }
  }));
  console.log(`confirmed ShopStar: ${subs.length} subdomains + ${hit}/${customs.length} customs = ${confirmed.length}`);

  const sql = postgres(process.env.DATABASE_URL || process.env.POSTGRES_URL, { ssl: "require", max: 2 });
  try {
    const rows = confirmed.map((d) => ({
      domain: d, name: d, platform: "ShopStar", country: "ZA", published: false,
      source: "shopstar_revip", country_source: "shopstar", discovered_at: new Date().toISOString(),
    }));
    const cols = ["domain", "name", "platform", "country", "published", "source", "country_source", "discovered_at"];
    let landed = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const res = await sql`INSERT INTO imported_stores ${sql(rows.slice(i, i + 500), ...cols)} ON CONFLICT (domain) DO NOTHING`;
      landed += res.count;
    }
    console.log(`landed ${landed} NEW ShopStar store(s) (ON CONFLICT skipped existing).`);
  } catch (e) { console.error("ERR", e.message); process.exitCode = 1; } finally { await sql.end(); }
}
main();
