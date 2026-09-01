/** Pin the country of stores we still have as NULL (mostly the "Africa"-labelled
 *  ones with no currency in the Sheet) by reading it straight from the storefront:
 *  Shopify.country (the shop's OWN country) is the primary signal; base store
 *  currency (Shopify.currency.active at rate 1.0, or /cart.js) is the fallback.
 *  This completes the per-country Africa repository — and pins non-African NULLs too.
 *
 *    node --env-file=.env.local scripts/reprobe-null-country.mjs [--apply] [--limit N]
 *
 *  Dry-run by default; pass --apply to write. Gentle (concurrency 4).
 */
import postgres from "postgres";

const APPLY = process.argv.includes("--apply");
const li = process.argv.indexOf("--limit");
const LIMIT = li > -1 ? Number(process.argv[li + 1]) : 0;
const CONCURRENCY = 4;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

// Single-country currency → ISO (fallback when Shopify.country is absent). Unambiguous
// only — shared XOF/XAF and non-specific USD/EUR stay unresolved.
const CCY_CC = {
  ZAR: "ZA", NGN: "NG", KES: "KE", GHS: "GH", EGP: "EG", MAD: "MA", TND: "TN",
  DZD: "DZ", MZN: "MZ", TZS: "TZ", UGX: "UG", RWF: "RW", ZMW: "ZM", MUR: "MU",
  BWP: "BW", NAD: "NA", ETB: "ET", AOA: "AO", KWD: "KW", QAR: "QA", BHD: "BH",
  OMR: "OM", AED: "AE", ILS: "IL", TRY: "TR", JPY: "JP", GBP: "GB", AUD: "AU",
  CAD: "CA", INR: "IN", BRL: "BR", MXN: "MX", NZD: "NZ", PKR: "PK", PLN: "PL",
};
const COUNTRY_RE = /Shopify\.country\s*=\s*["']([A-Z]{2})["']/;
const CCY_RE = /Shopify\.currency\s*=\s*\{[^}]*?"active"\s*:\s*"([A-Z]{3})"[^}]*?"rate"\s*:\s*"([0-9.]+)"/;

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(12000), redirect: "follow" });
  return res.ok ? res.text() : null;
}

async function pin(domain) {
  try {
    const html = await get(`https://${domain}/`);
    if (html) {
      const cm = COUNTRY_RE.exec(html);
      if (cm) return { cc: cm[1], via: "Shopify.country" };
      const mm = CCY_RE.exec(html);
      if (mm && ["1.0", "1", "1.00", "1.000"].includes(mm[2]) && CCY_CC[mm[1]]) return { cc: CCY_CC[mm[1]], via: `currency:${mm[1]}` };
    }
    // Fallback: cart currency (presentment default ≈ base for a single-currency shop).
    const cart = await get(`https://${domain}/cart.js`).catch(() => null);
    if (cart) { try { const c = JSON.parse(cart).currency; if (c && CCY_CC[c]) return { cc: CCY_CC[c], via: `cart:${c}` }; } catch { /* not json */ } }
  } catch { /* unreachable/timeout */ }
  return null;
}

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3 });
try {
  const rows = await sql`
    SELECT domain FROM imported_stores
    WHERE published AND country IS NULL
      AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
    ORDER BY estimated_monthly_sales DESC NULLS LAST
    ${LIMIT > 0 ? sql`LIMIT ${LIMIT}` : sql``}`;
  console.log(`Re-probing ${rows.length} NULL-country stores (concurrency ${CONCURRENCY})…`);

  let i = 0, pinned = 0, missed = 0;
  const results = [];
  async function worker() {
    while (i < rows.length) {
      const { domain } = rows[i++];
      const r = await pin(domain);
      if (r) {
        pinned++;
        results.push({ domain, ...r });
        console.log(`  ✓ ${domain} → ${r.cc}  (${r.via})`);
        if (APPLY) await sql`UPDATE imported_stores SET country = ${r.cc} WHERE domain = ${domain} AND country IS NULL`;
      } else { missed++; console.log(`  · ${domain} → (unresolved)`); }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const byCC = {};
  for (const r of results) byCC[r.cc] = (byCC[r.cc] || 0) + 1;
  console.log(`\n${pinned} pinned, ${missed} unresolved.  Breakdown: ${Object.entries(byCC).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join("  ") || "—"}`);
  console.log(APPLY ? "✓ Applied." : "DRY RUN — re-run with --apply to write.");
} finally { await sql.end(); }
