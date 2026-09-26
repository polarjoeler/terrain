/** Land headless_probe.py output into probe_checked, which reconcile-probed.mjs reads.
 *
 *    node --env-file=.env.local scripts/land-headless-probe.mjs [--file PATH]
 *
 *  Only rows WITH a detected platform are written. A null result means "the browser saw
 *  nothing headless", which is not evidence the store is anything in particular — writing
 *  it would mark the domain probed and stop the HTML probes from trying, losing coverage.
 */
import { readFileSync, writeFileSync, statSync } from "fs";
import postgres from "postgres";

const FILE = process.argv.includes("--file")
  ? process.argv[process.argv.indexOf("--file") + 1]
  : "/Users/joel/shopify-radar/feed/headless-probe.jsonl";
const OFFSET_FILE = FILE + ".offset";

// Byte-offset watermark: the feed is append-only, so re-reading it whole would grow
// without bound and eventually blow the statement timeout — the exact failure that
// took CT landing down. Reset if the file shrank so nothing is silently skipped.
function readOffset() {
  try {
    const off = parseInt(readFileSync(OFFSET_FILE, "utf8").trim(), 10);
    if (!Number.isFinite(off) || off < 0) return 0;
    return off > statSync(FILE).size ? 0 : off;
  } catch { return 0; }
}

async function main() {
  let size;
  try { size = statSync(FILE).size; } catch { console.log(`no feed at ${FILE}`); return; }
  const start = readOffset();
  let text = readFileSync(FILE).subarray(start, size).toString("utf8");
  if (start) text = text.slice(text.indexOf("\n") + 1);

  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.domain && r.platform) rows.push({ domain: String(r.domain).toLowerCase().replace(/^www\./, ""), platform: r.platform });
    } catch { /* skip malformed */ }
  }
  console.log(`read from byte ${start.toLocaleString()} of ${size.toLocaleString()} — ${rows.length} with a platform`);
  if (!rows.length) { writeFileSync(OFFSET_FILE, String(size)); return; }

  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 2, idle_timeout: 20 });
  try {
    let written = 0;
    for (let i = 0; i < rows.length; i += 400) {
      const batch = rows.slice(i, i + 400);
      // Only fill an EMPTY platform. A browser-detected headless platform should not
      // overwrite a confident HTML classification, and re-writing an identical value
      // costs a whole row version for nothing.
      const res = await sql`
        INSERT INTO probe_checked ${sql(batch, "domain", "platform")}
        ON CONFLICT (domain) DO UPDATE SET platform = EXCLUDED.platform, checked_at = now()
        WHERE COALESCE(probe_checked.platform, '') = ''`;
      written += res.count;
    }
    console.log(`✓ ${written.toLocaleString()} rows given a headless platform in probe_checked`);
    const by = rows.reduce((m, r) => (m[r.platform] = (m[r.platform] ?? 0) + 1, m), {});
    console.log("  " + Object.entries(by).map(([k, v]) => `${k}=${v}`).join(", "));
    writeFileSync(OFFSET_FILE, String(size));
    console.log("\nNext: reconcile-probed.mjs will set imported_stores.platform from these.");
  } finally { await sql.end(); }
}

main().catch((e) => { console.error(e); process.exit(1); });
