/** jp-city-enrich — pull each Japanese store's location (prefecture + city) from its own pages.
 *
 * Japan-specific + reliable: every JP store must publish a 特定商取引法 (tokushoho) notice with the
 * seller's address, and every Japanese address begins with one of the 47 prefectures. So we fetch
 * the homepage (address usually in the footer) and, if needed, the tokushoho page, and regex out
 * the prefecture (→ `region`) and the following city/ward (→ `city`). Own-domain GETs — no
 * Shopify-edge budget. Powers the /jp density-by-prefecture view.
 *
 *   node --env-file=.env.local scripts/jp-city-enrich.mjs [--limit 3000] [--concurrency 12] [--dry-run]
 */
import postgres from "postgres";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const LIMIT = parseInt(arg("--limit", "3000"), 10);
const CONC = parseInt(arg("--concurrency", "12"), 10);
const DRY = process.argv.includes("--dry-run");
const UA = "Mozilla/5.0 (compatible; terrain-radar/1.0; +jp-geo)";

const PREF = ["北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県",
  "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県", "新潟県", "富山県", "石川県", "福井県", "山梨県",
  "長野県", "岐阜県", "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県",
  "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県",
  "福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県"];
const PREF_RE = new RegExp(`(${PREF.join("|")})`);
// city/ward/town/village immediately after the prefecture (kanji/kana, up to ~7 chars ending 市区町村)
const CITY_RE = new RegExp(`(?:${PREF.join("|")})\\s*([一-龯ぁ-んァ-ヶー]{1,7}?[市区町村])`);
// Legal-notice pages carry the address even when the JS homepage doesn't. Covers Shopify JP
// (/policies/legal_notice, /pages/…), BASE/STORES, EC-CUBE (/help/), and common custom paths.
const TOKUSHO_PATHS = ["/policies/legal_notice", "/pages/tokushoho", "/pages/tokusho", "/pages/law",
  "/pages/legal", "/tokushoho", "/tokusho", "/law", "/help/tokushoho", "/help", "/company", "/about",
  "/shopguide", "/commercial-transactions", "/info/tokushoho"];

async function get(url) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 11000);
  try { return await fetch(url, { signal: c.signal, redirect: "follow", headers: { "User-Agent": UA } }); }
  catch { return null; } finally { clearTimeout(t); }
}
function parse(html) {
  const m = html.match(PREF_RE); if (!m) return null;
  const c = html.match(CITY_RE);
  return { region: m[1], city: c ? m[1] + c[1] : null };
}
async function mapLimit(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); })); }

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: Math.min(CONC + 1, 8), idle_timeout: 20 });
  try {
    await sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS region TEXT`;
    await sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS geo_checked_at TIMESTAMPTZ`;
    const rows = await sql`SELECT domain FROM imported_stores
      WHERE UPPER(country)='JP' AND published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
        AND region IS NULL AND geo_checked_at IS NULL
      ORDER BY estimated_monthly_sales DESC NULLS LAST LIMIT ${LIMIT}`;
    console.log(`jp-city-enrich: ${rows.length} JP stores${DRY ? " [DRY]" : ""}`);

    let found = 0, done = 0; const tally = new Map();
    await mapLimit(rows, CONC, async ({ domain }) => {
      let loc = null;
      // homepage first (address usually in footer), then the legal-notice pages
      for (const path of ["/", ...TOKUSHO_PATHS]) {
        const r = await get(`https://${domain}${path}`);
        if (r && r.ok) { loc = parse((await r.text().catch(() => "")).slice(0, 400_000)); if (loc) break; }
        if (path === "/" && r === null) break;   // domain unreachable
      }
      done++;
      if (loc) { found++; tally.set(loc.region, (tally.get(loc.region) ?? 0) + 1); }
      if (!DRY) {
        await sql`UPDATE imported_stores SET
          region = ${loc?.region ?? null}, city = COALESCE(${loc?.city ?? null}, city), geo_checked_at = now()
          WHERE domain = ${domain}`.catch(() => {});
      }
      if (done % 100 === 0) process.stdout.write(`\r  ${done}/${rows.length} · located ${found}`);
    });
    console.log(`\ndone. located ${found}/${rows.length} (${rows.length ? Math.round(100 * found / rows.length) : 0}%).`);
    console.log("top prefectures:", [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k}=${n}`).join(", "));
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
