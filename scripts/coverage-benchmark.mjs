/** coverage-benchmark — measure our recall against ANY external list of stores.
 *
 *  Point it at a domain list (a paid-source export, a scraped directory, the SA-100 PDF
 *  extract…) and it reports what fraction we already track — the honest recall number that
 *  tells you whether a paid source is worth buying, and which is the KPI behind "we're not
 *  missing stores". Optionally DNS-checks the ones we're missing against Shopify's /24 and
 *  writes the confirmed-live ones to the CT finds file so `land-ct-discoveries.mjs` captures
 *  them — so the same run that MEASURES the gap can also CLOSE it.
 *
 *    node --env-file=.env.local scripts/coverage-benchmark.mjs --file list.txt [--label sa100]
 *    node --env-file=.env.local scripts/coverage-benchmark.mjs --file list.txt --dns --emit
 *
 *  --dns   resolve the missing domains and classify against Shopify's 23.227.38.0/24
 *  --emit  append DNS-confirmed-Shopify misses to the CT finds file (implies --dns)
 *  --label store the result as a recall datapoint (coverage_benchmarks table) for /ops
 */
import postgres from "postgres";
import { readFileSync, appendFileSync, mkdirSync } from "fs";
import { promises as dns } from "dns";
import { dirname } from "path";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes(k);
const FILE = arg("--file", null);
const LABEL = arg("--label", null);
const DO_EMIT = has("--emit");
const DO_DNS = has("--dns") || DO_EMIT;
const FINDS = process.env.CT_FINDS || "/Users/joel/shopify-radar/feed/ct-discoveries.jsonl";
const SHOPIFY_PREFIX = "23.227.38.";

function norm(s) {
  let d = String(s).trim().toLowerCase();
  if (!d || d.startsWith("#")) return null;
  if (d.includes("://")) d = d.split("://")[1];
  d = d.replace(/^\/+/, "").split("/")[0].split("?")[0].split("#")[0].split("@").pop().split(":")[0];
  d = d.replace(/^www\./, "").replace(/\.+$/, "");
  return d.includes(".") && !d.includes(" ") ? d : null;
}

async function isShopify(domain) {
  for (const host of [domain, `www.${domain}`]) {
    try {
      const ips = await dns.resolve4(host);
      if (ips.some((ip) => ip.startsWith(SHOPIFY_PREFIX))) return true;
    } catch { /* try next */ }
  }
  return false;
}
async function resolves(domain) {
  for (const host of [domain, `www.${domain}`]) {
    try { if ((await dns.resolve4(host)).length) return true; } catch { /* next */ }
  }
  return false;
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

async function main() {
  if (!FILE) { console.error("usage: --file <domains.txt> [--label X] [--dns] [--emit]"); process.exit(2); }
  const list = [...new Set(readFileSync(FILE, "utf8").split("\n").map(norm).filter(Boolean))];
  if (!list.length) { console.error("no domains parsed from file"); process.exit(1); }

  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3, idle_timeout: 20 });
  try {
    const rows = await sql`
      SELECT lower(regexp_replace(domain,'^www\\.','')) AS d, platform, published, live_status
      FROM imported_stores
      WHERE lower(regexp_replace(domain,'^www\\.','')) = ANY(${list})`;
    const have = new Map(rows.map((r) => [r.d, r]));
    const present = list.filter((d) => have.has(d));
    const missing = list.filter((d) => !have.has(d));
    const total = list.length;
    const pct = ((present.length / total) * 100).toFixed(1);

    const byp = {};
    for (const d of present) { const r = have.get(d); const k = `${r.platform || "NULL"}/${r.published ? "pub" : "unpub"}`; byp[k] = (byp[k] || 0) + 1; }

    console.log(`\n=== coverage benchmark${LABEL ? ` [${LABEL}]` : ""}: ${FILE} ===`);
    console.log(`list ${total} | present ${present.length} (${pct}%) | missing ${missing.length}`);
    console.log("present breakdown:", JSON.stringify(byp));

    let confirmed = [], dead = [], notShop = [], emitted = 0;
    if (DO_DNS && missing.length) {
      process.stdout.write(`DNS-checking ${missing.length} missing against Shopify /24…\n`);
      const res = await mapLimit(missing, 40, async (d) => {
        if (await isShopify(d)) return ["shopify", d];
        if (await resolves(d)) return ["notshop", d];
        return ["dead", d];
      });
      for (const [k, d] of res) (k === "shopify" ? confirmed : k === "notshop" ? notShop : dead).push(d);
      console.log(`missing → live Shopify ${confirmed.length} | resolves-not-Shopify ${notShop.length} | dead/parked ${dead.length}`);
      if (confirmed.length) console.log("  capturable now:", confirmed.slice(0, 15).join(", ") + (confirmed.length > 15 ? " …" : ""));

      if (DO_EMIT && confirmed.length) {
        mkdirSync(dirname(FINDS), { recursive: true });
        const now = new Date().toISOString();
        for (const d of confirmed) {
          const cc = /\.(co|com|org|net|gov)?\.?za$/.test(d) ? "ZA" : (d.match(/\.([a-z]{2})$/)?.[1]?.toUpperCase() ?? null);
          appendFileSync(FINDS, JSON.stringify({ domain: d, country: cc, seen_at: now, source: `benchmark:${LABEL || "adhoc"}` }) + "\n");
          emitted++;
        }
        console.log(`→ emitted ${emitted} confirmed-Shopify to ${FINDS}; run land-ct-discoveries.mjs to publish.`);
      }
    }

    // True recall = present / (present + live-Shopify-we-missed). Dead/off-platform aren't our miss.
    const denom = DO_DNS ? present.length + confirmed.length : total;
    const trueRecall = denom ? ((present.length / denom) * 100).toFixed(1) : pct;
    if (DO_DNS) console.log(`\nTRUE recall (excluding dead/off-platform from the list): ${trueRecall}% of live in-scope stores`);

    if (LABEL) {
      await sql`CREATE TABLE IF NOT EXISTS coverage_benchmarks (
        id bigserial PRIMARY KEY, label text NOT NULL, ran_at timestamptz NOT NULL DEFAULT now(),
        list_total int, present int, missing int, coverage_pct numeric,
        live_missing int, true_recall_pct numeric, source_file text)`;
      await sql`INSERT INTO coverage_benchmarks
        ${sql({ label: LABEL, list_total: total, present: present.length, missing: missing.length,
          coverage_pct: Number(pct), live_missing: DO_DNS ? confirmed.length : null,
          true_recall_pct: DO_DNS ? Number(trueRecall) : null, source_file: FILE })}`;
      console.log(`\nstored recall datapoint '${LABEL}' → coverage_benchmarks (shows on /ops).`);
    }
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
