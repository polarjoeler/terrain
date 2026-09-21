/** import-leads-pdf — upsert parsed Lead Dashboard rows (from parse-leads-pdf.py) into
 *  imported_stores. Published as leads with their platform/country/sales, source='storeleads_pdf'.
 *  Never clobbers an existing row (COALESCE). Run the liveness pass after to confirm the source.
 *
 *    python3 scripts/parse-leads-pdf.py "/path/*.pdf" > /tmp/rows.json
 *    node --env-file=.env.local scripts/import-leads-pdf.mjs /tmp/rows.json
 *    node --env-file=.env.local scripts/jp-pdf-liveness.mjs    # measure the source
 */
import postgres from "postgres";
import { readFileSync } from "fs";

async function main() {
  const file = process.argv[2];
  const SRC = (process.argv.includes("--source") ? process.argv[process.argv.indexOf("--source")+1] : "storecensus");
  if (!file) { console.error("usage: import-leads-pdf.mjs <rows.json>"); process.exit(2); }
  const rows = JSON.parse(readFileSync(file, "utf8")).filter((r) => r.domain);
  const today = new Date().toISOString().slice(0, 10);
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3, idle_timeout: 20 });
  try {
    const recs = rows.map((r) => ({
      domain: r.domain, name: r.domain, country: r.country ?? null,
      platform: r.platform || "Shopify", published: true, source: SRC,
      discovered_at: today, estimated_monthly_sales: r.sales ?? null,
    }));
    const cols = ["domain", "name", "country", "platform", "published", "source", "discovered_at", "estimated_monthly_sales"];
    const before = (await sql`SELECT count(*)::int n FROM imported_stores WHERE domain = ANY(${recs.map((r) => r.domain)})`)[0].n;
    for (let i = 0; i < recs.length; i += 300) {
      await sql`INSERT INTO imported_stores ${sql(recs.slice(i, i + 300), ...cols)}
        ON CONFLICT (domain) DO UPDATE SET
          estimated_monthly_sales = COALESCE(imported_stores.estimated_monthly_sales, EXCLUDED.estimated_monthly_sales),
          platform      = COALESCE(imported_stores.platform, EXCLUDED.platform),
          country       = COALESCE(imported_stores.country, EXCLUDED.country),
          discovered_at = COALESCE(imported_stores.discovered_at, EXCLUDED.discovered_at)`;
    }
    console.log(`imported ${recs.length} rows (${recs.length - before} new, ${before} already present).`);
    console.log("→ run jp-pdf-liveness.mjs (or verify-liveness --from-file) to confirm the source.");
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
