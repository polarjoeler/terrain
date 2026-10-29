#!/usr/bin/env node
// selar-enrich — one PACED pass over banked Selar stores that, in a single store-page fetch, sets
// LIVENESS (active/inactive/dead) and the real NAME. Country is intentionally NOT set (see below).
//
// Selar stores all live on ONE host (selar.com), so this is deliberately gentle (low concurrency +
// a delay between fetches) — not the fan-out the own-domain contact lane uses. And it's LOW-CADENCE
// by design: Selar is lower-value than Shopify, so run it monthly / on demand, not nightly.
//
// WHY NO COUNTRY: the obvious signal (currency on the page) is a trap. The rendered currency is the
// SWITCHER's display default (ZAR), not the seller's — counting it mislabeled Nigerian sellers as
// South African on a 40-store sample (2026-10-29). The seller's real base currency is a Nuxt
// payload index (`default_currency:N`) that needs a proper payload parser to resolve. Until that
// exists we leave country NULL rather than guess wrong (USD is also NEVER United States — African
// sellers price in USD). A country resolver is a separate, deferred task.
//
// Run:  node --env-file=.env.local scripts/selar-enrich.mjs --sample 100   # validate, no writes
//       node --env-file=.env.local scripts/selar-enrich.mjs --limit 5000   # enrich a batch
import postgres from "postgres";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SAMPLE = Number(arg("--sample", "0"));          // fetch N, print, NO writes (validation)
const DRY = process.argv.includes("--dry") || SAMPLE > 0;
const LIMIT = SAMPLE || Number(arg("--limit", "2000"));
const CONC = Number(arg("--conc", "2"));              // gentle: one host
const DELAY = Number(arg("--delay", "700"));          // ms between a worker's fetches
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// Unambiguous single-country currencies → ISO2. African focus first. USD/GBP/EUR/other multi-country
// (XOF/XAF CFA zones) are DELIBERATELY ABSENT → country stays unknown. USD is NOT United States.
const CCY_COUNTRY = {
  ZAR: "ZA", NGN: "NG", KES: "KE", GHS: "GH", UGX: "UG", TZS: "TZ", RWF: "RW", ZMW: "ZM",
  EGP: "EG", MAD: "MA", NAD: "NA", BWP: "BW", MUR: "MU", ETB: "ET", MWK: "MW", MZN: "MZ",
  AOA: "AO", INR: "IN", // non-African single-country ones we can still place honestly
};
const CCY_RE = /\b(ZAR|NGN|KES|GHS|UGX|TZS|RWF|ZMW|EGP|MAD|NAD|BWP|MUR|ETB|MWK|MZN|AOA|INR|USD|GBP|EUR|CAD|AUD)\b/g;

async function get(url, timeoutMs = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: ac.signal });
    const body = await r.text();
    return { status: r.status, finalUrl: r.url, body };
  } catch { return null; }
  finally { clearTimeout(t); }
}

// Modal currency → country. Returns { country, currency, confident }.
function deriveCountry(html) {
  const counts = {};
  for (const m of html.matchAll(CCY_RE)) counts[m[1]] = (counts[m[1]] ?? 0) + 1;
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { country: null, currency: null, confident: false };
  const [ccy, n] = ranked[0];
  // Confidence: the real currency repeats; the selector list shows each once. Require a clear lead.
  const confident = n >= 3 && (ranked.length < 2 || n > ranked[1][1]);
  const country = confident ? (CCY_COUNTRY[ccy] ?? null) : null;   // USD/GBP/EUR/CFA → null (unknown, NOT US)
  return { country, currency: ccy, confident };
}

function deriveName(html, slug) {
  const og = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)?.[1];
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
  const name = (og || title || "")
    .replace(/\s*(?:[|–—·-]|&middot;)\s*selar.*$/i, "")   // strip the " · Selar" suffix (any separator)
    .replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  // Reject empties, bare "Selar", and 404/error titles — fall back to the handle (never persist junk).
  if (!name || /^selar$/i.test(name) || /page not found|not found|unavailable|error/i.test(name)) return slug;
  return name;
}

// A live Selar store page carries currency + the store scaffold; a deleted one 404s or bounces home.
function liveness({ status, finalUrl, body }) {
  if (status === 404 || status >= 500) return "dead";
  if (/\/m\//.test(finalUrl) === false) return "dead";                 // bounced off the /m/<slug> path
  if (/store (not found|unavailable|does not exist)|page not found/i.test(body)) return "dead";
  if (status === 200 && CCY_RE.test(body)) return "active";
  return "inactive";
}

async function main() {
  console.log(`selar-enrich${SAMPLE ? ` [SAMPLE ${SAMPLE}]` : DRY ? " [DRY]" : ""} · conc ${CONC} · ${DELAY}ms`);
  const sql = postgres(process.env.DATABASE_URL || process.env.POSTGRES_URL, { ssl: "require", max: Math.min(CONC + 1, 6) });
  try {
    const rows = await sql`
      SELECT domain, name FROM imported_stores
      WHERE platform = 'Selar' AND source = 'selar_sitemap'
        AND (country IS NULL OR live_checked_at IS NULL)
      ORDER BY last_alive_at DESC NULLS LAST
      LIMIT ${LIMIT}`;
    if (!rows.length) { console.log("nothing to enrich — all Selar stores have country + a liveness check."); return; }
    console.log(`enriching ${rows.length} Selar store(s)…`);

    const tally = { active: 0, dead: 0, inactive: 0 };
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(CONC, rows.length) }, async () => {
      while (cursor < rows.length) {
        const { domain, name: slug } = rows[cursor++];
        const res = await get(`https://${domain}`);
        if (!res) { console.log(`  ! ${domain}: fetch failed`); continue; }
        const status = liveness(res);
        const name = deriveName(res.body, slug);
        // COUNTRY IS DELIBERATELY NOT WRITTEN. The rendered currency (ZAR in the switcher) is a
        // display/default artifact, not the seller's — counting it mislabels Nigerian sellers as ZA
        // (verified on a 40-store sample, 2026-10-29). The real base currency is a Nuxt payload
        // index (`default_currency:N`) that needs a proper payload parser; until that exists we
        // leave country NULL rather than guess wrong. USD is never United States (African sellers
        // price in USD). deriveCountry() is kept only for --sample visibility, never persisted.
        const dbg = SAMPLE ? deriveCountry(res.body) : null;
        tally[status]++;
        if (SAMPLE) console.log(`  ${domain}  →  ${status}  "${name}"   [ccy-guess ${dbg.currency ?? "none"}${dbg.confident ? "" : " low-conf"} — NOT written]`);
        else if (!DRY) {
          await sql`UPDATE imported_stores SET
            name = ${name},
            live_status = ${status},
            live_checked_at = now(),
            live_platform = 'Selar'
            WHERE domain = ${domain}`;
        }
        await new Promise((r) => setTimeout(r, DELAY));
      }
    }));
    console.log(`\ndone. ${tally.active} active / ${tally.inactive} inactive / ${tally.dead} dead. (country not derived — see header note.)`);
  } catch (e) { console.error("ERR", e.message); process.exitCode = 1; }
  finally { await sql.end(); }
}
main();
