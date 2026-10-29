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
  const candidates = [...seen];
  console.log(`total unique: ${candidates.length} (subdomains: ${candidates.filter((d) => d.endsWith(".shopstar.co.za")).length})`);
  if (DRY) { candidates.slice(0, 15).forEach((d) => console.log("  " + d)); console.log("[DRY] no writes, no confirm fetches."); return; }
  if (!seen.size) { console.log("nothing to land (reverse-IP returned nothing — likely rate-limited; retry later)."); return; }

  // Confirm EVERY candidate via the ShopStar needle (shared xneelo IP → co-tenants must be excluded).
  // A 200 + needle also = live, so we stamp live_status here → promote-confirmed can surface them.
  const confirmed = [];
  let ci = 0;
  await Promise.all(Array.from({ length: 5 }, async () => {
    while (ci < candidates.length) {
      const d = candidates[ci++];
      if (await isShopStar(d)) confirmed.push(d);
      await new Promise((r) => setTimeout(r, 250));
    }
  }));
  console.log(`confirmed live ShopStar: ${confirmed.length} / ${candidates.length}`);
  if (!confirmed.length) { console.log("none confirmed."); return; }

  const sql = postgres(process.env.DATABASE_URL || process.env.POSTGRES_URL, { ssl: "require", max: 2 });
  try {
    const now = new Date().toISOString();
    const rows = confirmed.map((d) => ({
      domain: d, name: d, platform: "ShopStar", country: "ZA", published: false,
      source: "shopstar_revip", country_source: "shopstar", discovered_at: now,
      live_status: "active", live_checked_at: now, last_alive_at: now,
    }));
    const cols = ["domain", "name", "platform", "country", "published", "source", "country_source", "discovered_at", "live_status", "live_checked_at", "last_alive_at"];
    let n = 0;
    for (let i = 0; i < rows.length; i += 500) {
      // Upsert: new rows land; existing rows (incl. the 615 from the first run) get their live
      // fields refreshed so they're promotable — but never clobber a manual country override.
      const res = await sql`INSERT INTO imported_stores ${sql(rows.slice(i, i + 500), ...cols)}
        ON CONFLICT (domain) DO UPDATE SET
          live_status = EXCLUDED.live_status, live_checked_at = EXCLUDED.live_checked_at, last_alive_at = EXCLUDED.last_alive_at,
          platform = COALESCE(imported_stores.platform, EXCLUDED.platform),
          country = CASE WHEN imported_stores.country_source = 'manual' THEN imported_stores.country ELSE COALESCE(imported_stores.country, EXCLUDED.country) END`;
      n += rows.slice(i, i + 500).length;
    }
    console.log(`upserted ${confirmed.length} confirmed ShopStar store(s) with live_status=active.`);
  } catch (e) { console.error("ERR", e.message); process.exitCode = 1; } finally { await sql.end(); }
}
main();
