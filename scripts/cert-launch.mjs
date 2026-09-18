#!/usr/bin/env node
/**
 * Cert-transparency launch-date fallback. For live target-market stores that have NO product-based
 * launch date (first_product_at / launched_at both null — usually because products.json was blocked
 * or the store's catalog is empty), estimate the launch date from the domain's EARLIEST SSL cert via
 * crt.sh: a Shopify store gets a cert at setup, so min(not_before) ≈ when the store went live.
 *
 *   node --env-file=.env.local scripts/cert-launch.mjs [--limit 500] [--concurrency 3]
 *
 * Writes launched_at + launched_source='cert' ONLY where launched_at IS NULL — so a real product
 * date always wins. Marks cert_checked_at so we never re-hit crt.sh for the same store; a crt.sh
 * OUTAGE leaves cert_checked_at null so a later run retries. (crt.sh is flaky — that's expected.)
 * Caveat: for a domain repurposed from an older site the earliest cert predates the Shopify launch,
 * so 'cert' dates are estimates, tagged as such, and never overwrite a product-verified date.
 */
import postgres from "postgres";

const MARKETS = ["AO","BW","CI","CM","DZ","EG","ET","GH","KE","LS","LY","MA","MU","MW","MZ","NA",
  "NG","RW","SN","SO","SZ","TN","TZ","UG","ZA","ZM","ZW","JP"];
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const LIMIT = parseInt(arg("--limit", "500"), 10);
const CONC = parseInt(arg("--concurrency", "3"), 10);

async function certDate(domain) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(`https://crt.sh/?q=${encodeURIComponent(domain)}&output=json`, {
      signal: ctrl.signal, headers: { "User-Agent": "terrain-radar/1.0" },
    });
    if (!r.ok) return { ok: false };                          // crt.sh error → retry later
    const arr = await r.json().catch(() => null);
    if (!Array.isArray(arr)) return { ok: false };
    let min = null;
    for (const c of arr) {
      const nb = c.not_before;                                // "YYYY-MM-DDTHH:MM:SS"
      if (nb && /^\d{4}-\d{2}-\d{2}/.test(nb) && (!min || nb < min)) min = nb;
    }
    return { ok: true, date: min ? min.slice(0, 10) : null };  // null = no cert on record
  } catch {
    return { ok: false };                                     // timeout/network → retry later
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: Math.min(CONC + 1, 4), idle_timeout: 20 });
  try {
    await sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS cert_checked_at TIMESTAMPTZ`;
    const rows = await sql`
      SELECT domain FROM imported_stores
      WHERE published AND platform = 'Shopify' AND UPPER(country) = ANY(${MARKETS})
        AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
        AND launched_at IS NULL AND cert_checked_at IS NULL
      ORDER BY discovered_at DESC NULLS LAST
      LIMIT ${LIMIT}`;
    console.log(`cert-dating ${rows.length} undated stores (concurrency ${CONC})…`);
    let dated = 0, nocert = 0, failed = 0, i = 0;
    async function worker() {
      while (i < rows.length) {
        const { domain } = rows[i++];
        const res = await certDate(domain);
        if (!res.ok) { failed++; continue; }                  // leave cert_checked_at null → retry
        if (res.date) {
          await sql`UPDATE imported_stores SET launched_at = ${res.date}::date, launched_source = 'cert',
                    cert_checked_at = now() WHERE domain = ${domain} AND launched_at IS NULL`.catch(() => {});
          dated++;
        } else {
          await sql`UPDATE imported_stores SET cert_checked_at = now() WHERE domain = ${domain}`.catch(() => {});
          nocert++;
        }
        if ((dated + nocert + failed) % 50 === 0)
          process.stdout.write(`\r  ${dated + nocert + failed}/${rows.length}  (dated ${dated}, no-cert ${nocert}, crt.sh-failed ${failed})`);
        await new Promise((r) => setTimeout(r, 150));          // be polite to crt.sh
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, rows.length) }, worker));
    process.stdout.write("\n");
    console.log(`✓ Done. dated ${dated} · no cert ${nocert} · crt.sh failed (will retry) ${failed}`);
  } finally {
    await sql.end();
  }
}

main().catch((e) => { console.error("cert-launch failed:", e.message); process.exit(1); });
