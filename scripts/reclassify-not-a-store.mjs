/** reclassify-not-a-store — the 'not_a_store' tag was set from the HOMEPAGE only, but WooCommerce
 *  stores routinely have a landing-page homepage with the shop on /shop, so some real stores were
 *  mislabeled and then HIDDEN from the product. Markup heuristics proved unreliable both ways, so
 *  this routes each not_a_store row through shopify-radar's catalog-grade store_classifier.py
 *  (STORE only when score>=6 AND a real product catalog is found) and lands the verdict:
 *    STORE                 → activity_tier='active'   (recovered — a genuine store, counts again)
 *    MAYBE/NOT_STORE/other → stays 'not_a_store'      (kept + clearly tagged, excluded from Insights)
 *  Nothing is deleted. store_classifier probes via the Webshare proxy fleet (not the single IP).
 *  Resumable via not_a_store_checked_at.
 *
 *    node --env-file=.env.local scripts/reclassify-not-a-store.mjs [--country ZA] [--limit 2000] [--all] [--dry-run]
 */
import postgres from "postgres";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const ALL = process.argv.includes("--all");
const DRY = process.argv.includes("--dry-run");
const COUNTRY = arg("--country", null);
const LIMIT = ALL ? 0 : parseInt(arg("--limit", "2000"), 10);
const CONC = parseInt(arg("--concurrency", "30"), 10);
const RADAR = join(homedir(), "shopify-radar");
const PY = join(RADAR, ".venv", "bin", "python");

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 4, idle_timeout: 20 });
try {
  await sql`SET lock_timeout = '4s'`;
  await sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS not_a_store_checked_at TIMESTAMPTZ`.catch(() => {});
  const rows = await sql`
    SELECT domain FROM imported_stores
    WHERE published AND activity_tier = ${"not_a_store"} AND not_a_store_checked_at IS NULL
      ${COUNTRY ? sql`AND country = ${COUNTRY.toUpperCase()}` : sql``}
    ORDER BY estimated_monthly_sales DESC NULLS LAST, discovered_at DESC NULLS LAST
    ${LIMIT > 0 ? sql`LIMIT ${LIMIT}` : sql``}`;
  console.log(`reclassify-not-a-store: ${rows.length.toLocaleString()} rows${COUNTRY ? ` (${COUNTRY})` : ""} → store_classifier${DRY ? " [DRY]" : ""}`);
  if (!rows.length) { await sql.end(); process.exit(0); }

  const tmp = join(RADAR, "feed", "not-a-store-recheck.txt");
  writeFileSync(tmp, rows.map((r) => r.domain).join("\n") + "\n");

  // Run the catalog-grade classifier (proxy fleet). Collect its JSONL verdicts.
  const out = await new Promise((resolve, reject) => {
    let data = "";
    const p = spawn(PY, [join(RADAR, "store_classifier.py"), "--from-file", tmp, "--source", "not_a_store_recheck", "--concurrency", String(CONC)], { cwd: RADAR });
    p.stdout.on("data", (d) => (data += d));
    p.stderr.on("data", () => {}); // suppress py FutureWarnings
    p.on("error", reject);
    p.on("close", () => resolve(data));
  });

  let recovered = 0, kept = 0, unreachable = 0, bad = 0;
  const byVerdict = new Map();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { bad++; continue; }
    const v = r.verdict;
    byVerdict.set(v, (byVerdict.get(v) ?? 0) + 1);
    if (v === "STORE") {
      recovered++;
      if (DRY) console.log(`  RECOVER → active  score=${r.score}  ${r.domain}  ${r.name ?? ""}`);
      else await sql`UPDATE imported_stores SET activity_tier = ${"active"}, not_a_store_checked_at = now() WHERE domain = ${r.domain} AND activity_tier = ${"not_a_store"}`.catch(() => { recovered--; });
    } else {
      if (v === "UNREACHABLE") unreachable++; else kept++;
      if (!DRY) await sql`UPDATE imported_stores SET not_a_store_checked_at = now() WHERE domain = ${r.domain}`.catch(() => {});
    }
  }
  console.log(`\n✓ ${DRY ? "would recover" : "recovered"} ${recovered} real stores · ${kept} kept not_a_store · ${unreachable} unreachable${bad ? ` · ${bad} unparsed` : ""}`);
  console.log("verdicts:", [...byVerdict.entries()].map(([k, n]) => `${k}=${n}`).join("  "));
} finally { await sql.end(); }
