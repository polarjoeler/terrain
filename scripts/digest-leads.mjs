#!/usr/bin/env node
/**
 * Digest lead-export — for a payment provider (or any customer), pull the lead lists we'd
 * SHARE in their weekly digest, write each as a CSV they can work immediately, and print a
 * highlights block (a few standout examples + counts + est value + why) for the report itself.
 *
 *   node --env-file=.env.local scripts/digest-leads.mjs --provider Paystack --markets ZA,NG,KE,GH
 *
 * Writes CSVs to feed/digests/<provider>-<list>-<date>.csv and prints highlights to stdout.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import postgres from "postgres";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PROVIDER = opt("--provider", "Paystack");
const MARKETS = opt("--markets", "ZA,NG,KE,GH").split(",").map((s) => s.trim().toUpperCase());
const DATE = new Date().toISOString().slice(0, 10);
const OUT_DIR = opt("--out", "feed/digests");

const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false });
const COLS = ["domain", "name", "country", "city", "category", "estimated_monthly_sales", "currency", "plus", "payments", "discovered_at", "email"];
const esc = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const usd = (n) => n == null ? "—" : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n)}`;

function writeCsv(name, rows) {
  mkdirSync(OUT_DIR, { recursive: true });
  const path = `${OUT_DIR}/${PROVIDER.toLowerCase()}-${name}-${DATE}.csv`;
  const body = [COLS.join(","), ...rows.map((r) => COLS.map((c) => esc(r[c])).join(","))].join("\n");
  writeFileSync(path, body + "\n");
  return path;
}
function highlights(title, why, rows) {
  const withVal = rows.filter((r) => r.estimated_monthly_sales != null).length;
  console.log(`\n■ ${title} — ${rows.length.toLocaleString()} stores`);
  console.log(`  why: ${why}`);
  const top = [...rows].sort((a, b) => (b.estimated_monthly_sales ?? 0) - (a.estimated_monthly_sales ?? 0)).slice(0, 5);
  for (const r of top) console.log(`  • ${r.domain}  (${r.country})  ${usd(r.estimated_monthly_sales)}${r.plus ? "  PLUS" : ""}`);
  if (withVal < rows.length) console.log(`  (${withVal} of ${rows.length} have a revenue estimate)`);
}

const LIVE = sql`published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))`;
const IN_MK = sql`UPPER(country) = ANY(${MARKETS})`;
const HAS_PROV = sql`EXISTS (SELECT 1 FROM unnest(string_to_array(lower(payments),';')) g WHERE btrim(g) LIKE ${'%' + PROVIDER.toLowerCase() + '%'})`;

async function main() {
  // 1) Launched last week — new merchants to reach before a default gateway is set.
  const launched = await sql`SELECT ${sql(COLS)} FROM imported_stores
    WHERE ${LIVE} AND ${IN_MK} AND discovered_at >= now() - interval '7 days'
    ORDER BY estimated_monthly_sales DESC NULLS LAST`;
  // 2) Checked, no gateway yet — probed at checkout, no provider rendered (open field).
  const noGw = await sql`SELECT ${sql(COLS)} FROM imported_stores
    WHERE ${LIVE} AND ${IN_MK} AND payments_checked_at IS NOT NULL AND (payments IS NULL OR payments = '')
    ORDER BY estimated_monthly_sales DESC NULLS LAST`;
  // 3) Poaching targets — high-value merchants on a COMPETING gateway (not the provider).
  const poach = await sql`SELECT ${sql(COLS)} FROM imported_stores
    WHERE ${LIVE} AND ${IN_MK} AND payments IS NOT NULL AND payments <> '' AND NOT ${HAS_PROV}
    ORDER BY estimated_monthly_sales DESC NULLS LAST LIMIT 250`;

  const p1 = writeCsv("launched-last-week", launched);
  const p2 = writeCsv("no-gateway-yet", noGw);
  const p3 = writeCsv("poaching-targets", poach);

  console.log(`${PROVIDER} digest leads · markets ${MARKETS.join("/")} · ${DATE}`);
  highlights("Launched last week", "new merchants — reach them before a competitor becomes their default gateway", launched);
  highlights("Checked · no gateway yet", "we probed checkout and it rendered NO provider — an open field with no incumbent to displace", noGw);
  highlights("Poaching targets (on competing rails)", "high-value merchants already taking payments on a rival/generic gateway — conversion targets", poach);
  console.log(`\nCSVs written:\n  ${p1}\n  ${p2}\n  ${p3}`);
  await sql.end();
}
main().catch((e) => { console.error("digest-leads failed:", e.message); process.exit(1); });
