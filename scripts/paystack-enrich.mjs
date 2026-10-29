#!/usr/bin/env node
// Paystack Storefront country + liveness pass — turns banked paystack.shop/<slug> rows into
// dashboard-ready leads. One PACED fetch per store (all on one host, paystack.shop) reads the
// store's currency from its __NEXT_DATA__ ("currency":"NGN"|"GHS"|"ZAR") → country, confirms
// liveness, and grabs the real name. Resilient writes (retry/backoff) so Supabase contention slows
// it, never kills it. Once country is set, promote-confirmed (last_alive_at proxy) publishes it.
//
// Run:  node --env-file=.env.local scripts/paystack-enrich.mjs --sample 20   # validate, no writes
//       node --env-file=.env.local scripts/paystack-enrich.mjs --limit 5000
import postgres from "postgres";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SAMPLE = Number(arg("--sample", "0"));
const DRY = process.argv.includes("--dry") || SAMPLE > 0;
const LIMIT = SAMPLE || Number(arg("--limit", "2000"));
const CONC = Number(arg("--conc", "2"));
const DELAY = Number(arg("--delay", "700"));
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// Paystack Storefront exists only in NG/GH/ZA, so the store currency pins the country exactly.
const CCY_COUNTRY = { NGN: "NG", GHS: "GH", ZAR: "ZA" };  // USD (rare) → null

async function get(url, timeoutMs = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try { const r = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: ac.signal }); return { status: r.status, finalUrl: r.url, body: await r.text() }; }
  catch { return null; } finally { clearTimeout(t); }
}

function deriveCountry(html) {
  const counts = {};
  for (const m of html.matchAll(/"currency":"([A-Z]{3})"/g)) counts[m[1]] = (counts[m[1]] ?? 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const ccy = top?.[0] ?? null;
  return { country: ccy ? (CCY_COUNTRY[ccy] ?? null) : null, currency: ccy };
}
function deriveName(html, slug) {
  const og = html.match(/<meta[^>]+property=["']og:(?:site_name|title)["'][^>]+content=["']([^"']+)["']/i)?.[1];
  let name = (og || "").replace(/\s*[-–—|·]\s*paystack.*$/i, "").replace(/^shop\s+/i, "").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  if (!name || /paystack|not found|unavailable/i.test(name)) return slug;
  return name;
}
function liveness({ status, finalUrl, body }) {
  if (status === 404 || status >= 500) return "dead";
  if (!/paystack\.shop\/[^/?#]/.test(finalUrl)) return "dead";                 // bounced off the store path
  if (/store (not found|unavailable|does not exist)|page not found/i.test(body)) return "dead";
  if (status === 200 && body.includes('"currency"')) return "active";
  return "inactive";
}

async function main() {
  console.log(`paystack-enrich${SAMPLE ? ` [SAMPLE ${SAMPLE}]` : DRY ? " [DRY]" : ""} · conc ${CONC} · ${DELAY}ms`);
  const sql = postgres(process.env.DATABASE_URL || process.env.POSTGRES_URL, { ssl: "require", max: Math.min(CONC + 1, 6) });
  try {
    const rows = await sql`SELECT domain, name FROM imported_stores
      WHERE platform = 'Paystack Storefront' AND (country IS NULL OR live_checked_at IS NULL)
      ORDER BY discovered_at DESC NULLS LAST LIMIT ${LIMIT}`;
    if (!rows.length) { console.log("nothing to enrich."); return; }
    console.log(`enriching ${rows.length} Paystack store(s)…`);
    const tally = { active: 0, dead: 0, inactive: 0, countried: 0 };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const TRANSIENT = /lock timeout|statement timeout|canceling statement|timeout|connection|too many clients|ECONNRESET|terminating|deadlock/i;
    let cursor = 0, dbErrs = 0, skipped = 0;
    async function writeRow(q) {
      for (let a = 0; a < 4; a++) {
        try { await q(); return; }
        catch (e) { if (!TRANSIENT.test(e.message || "") || a === 3) { if (++dbErrs <= 8) console.log(`  ! db: ${e.message}`); return; } await sleep(400 * (a + 1) * (a + 1)); }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, rows.length) }, async () => {
      while (cursor < rows.length) {
        const { domain, name: slug } = rows[cursor++];
        try {
          const res = await get(`https://${domain}`);
          if (!res) { skipped++; await sleep(DELAY); continue; }
          const status = liveness(res);
          const { country, currency } = deriveCountry(res.body);
          const name = deriveName(res.body, slug);
          tally[status]++; if (country) tally.countried++;
          if (SAMPLE) console.log(`  ${domain}  →  ${status}  ${country ?? "??"}  (${currency ?? "no-ccy"})  "${name}"`);
          else await writeRow(() => sql`UPDATE imported_stores SET
            country = COALESCE(${country}, country),
            country_source = ${country ? "paystack_currency" : sql`country_source`},
            name = ${name}, live_status = ${status}, live_checked_at = now(), live_platform = 'Paystack Storefront'
            WHERE domain = ${domain}`);
        } catch (e) { if (++skipped <= 8) console.log(`  ! ${domain}: ${e.message}`); }
        await sleep(DELAY);
      }
    }));
    console.log(`\ndone. ${tally.active} active / ${tally.inactive} inactive / ${tally.dead} dead · country set: ${tally.countried} · skipped: ${skipped} · db-errs: ${dbErrs}`);
  } catch (e) { console.error("ERR", e.message); process.exitCode = 1; } finally { await sql.end(); }
}
main();
