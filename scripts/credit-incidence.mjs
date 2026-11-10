/** credit-incidence — measure how often stores actually NAME the agency that built them.
 *
 *  A measurement pass, not an attribution pass. Draws a RANDOM sample of published stores (random, not
 *  rank-ordered — rank-ordering oversamples big stores and biases the rate), fetches each, runs the
 *  shared builder-credit detector (scripts/lib/builder-credits.mjs — the SAME parse production uses),
 *  and reports the incidence rate with a 95% CI, broken down by signal type and platform. READ-ONLY:
 *  it writes nothing, so a store stays available for the real attribution pass.
 *
 *  Same residential-IP discipline as attribute-partners: Shopify → Webshare proxy fleet, everything
 *  else direct; paced; stops once --sample stores have actually been fetched.
 *
 *    node --env-file=.env.local scripts/credit-incidence.mjs --country ZA --sample 2000 [--conc 3] [--delay 350] [--fresh-only]
 */
import postgres from "postgres";
import { loadProxies, pickProxy, fetchText, closeAgents } from "./lib/proxy-fetch.mjs";
import { detectCredits, hostOf } from "./lib/builder-credits.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const COUNTRIES = arg("--country", "ZA").toUpperCase().split(",").map((c) => c.trim()).filter(Boolean);
const SAMPLE = parseInt(arg("--sample", "2000"), 10);
const CONC = Math.max(1, parseInt(arg("--conc", "3"), 10));
const DELAY = Math.max(0, parseInt(arg("--delay", "350"), 10));
const FRESH = process.argv.includes("--fresh-only");   // exclude partner_checked_at IS NOT NULL
const UA = "Mozilla/5.0 (compatible; terrain-radar/1.0; +credit-incidence)";
const PROXIES = loadProxies();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isShopify = (p) => /shopify/i.test(p || "");
const platClass = (p) => { const l = (p || "").toLowerCase(); return isShopify(l) ? "shopify" : /woo/.test(l) ? "woocommerce" : (l || "other"); };

async function getDirect(url) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 12000);
  try { const r = await fetch(url, { signal: c.signal, redirect: "follow", headers: { "User-Agent": UA } });
    return { status: r.status, html: await r.text().catch(() => "") }; }
  catch { return null; } finally { clearTimeout(t); }
}
async function fetchStore(domain, platform) {
  if (PROXIES.length && isShopify(platform)) {
    const r = await fetchText(`https://${domain}/`, { proxy: pickProxy(PROXIES), ua: UA, timeoutMs: 12000, maxBytes: 400_000 });
    return r ? { status: r.status, html: r.text, lane: "proxy" } : null;
  }
  const r = await getDirect(`https://${domain}/`);
  return r ? { status: r.status, html: r.text, lane: "direct" } : null;
}
async function mapLimit(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { await fn(items[i++]); if (DELAY) await sleep(DELAY + Math.random() * DELAY); }
  }));
}

function ci95(credited, n) {
  if (!n) return { p: 0, lo: 0, hi: 0, moe: 0 };
  const p = credited / n, se = Math.sqrt((p * (1 - p)) / n), moe = 1.96 * se;
  return { p, lo: Math.max(0, p - moe), hi: Math.min(1, p + moe), moe };
}
const pct = (x) => `${(x * 100).toFixed(1)}%`;

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 3, idle_timeout: 20,
    connect_timeout: 30, connection: { statement_timeout: 120000 } });
  try {
    const partners = await sql`SELECT id, name, website_url FROM service_partners`;
    const byHost = new Map(), byName = new Map();
    for (const p of partners) { const h = p.website_url ? hostOf(p.website_url) : null; if (h) byHost.set(h, p.id); if (p.name) byName.set(p.name.toLowerCase().trim(), p.id); }

    // Random draw (over-draw ~1.6x so errors/unreachable don't starve the target n). ORDER BY random()
    // is fine at this scale; the point is an UNBIASED sample, not the top-of-queue head.
    const DRAW = Math.ceil(SAMPLE * 1.6);
    const pool = await sql`
      SELECT domain, platform FROM imported_stores
      WHERE published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
        AND country = ANY(${COUNTRIES})
        ${FRESH ? sql`AND partner_checked_at IS NULL` : sql``}
      ORDER BY random() LIMIT ${DRAW}`;
    console.log(`drew ${pool.length} random ${COUNTRIES.join(",")} stores; target fetched n=${SAMPLE}; proxies: ${PROXIES.length}`);

    let fetched = 0, unreachable = 0, credited = 0, direct429 = 0, proxyFail = 0;
    const sigCount = {};            // signal type -> # stores where it fired
    const byPlat = {};              // platform class -> {fetched, credited}
    const candNames = new Map();    // flagged unknown agencies (name -> example store)
    let matchedKnown = 0;
    const done = () => fetched >= SAMPLE;

    await mapLimit(pool, CONC, async ({ domain, platform }) => {
      if (done()) return;
      const r = await fetchStore(domain, platform);
      if (!r) { unreachable++; proxyFail++; return; }
      if (r.status === 429) { unreachable++; if (r.lane === "direct") direct429++; return; }
      if (r.status < 200 || r.status >= 300 || !r.html) { unreachable++; return; }
      if (done()) return;
      fetched++;
      const store = domain.replace(/^www\./, "");
      const res = detectCredits(r.html, { byName, byHost, store });
      const pc = platClass(platform);
      byPlat[pc] ??= { fetched: 0, credited: 0 };
      byPlat[pc].fetched++;
      if (res.credited) { credited++; byPlat[pc].credited++; for (const s of res.signals) sigCount[s] = (sigCount[s] ?? 0) + 1; }
      if (res.matched.length) matchedKnown++;
      for (const c of res.candidates) if (!candNames.has(c.name)) candNames.set(c.name, { host: c.host, store });
    });

    // ---- report ----
    const o = ci95(credited, fetched);
    console.log(`\n=== BUILDER-CREDIT INCIDENCE · ${COUNTRIES.join(",")} ===`);
    console.log(`fetched (denominator): ${fetched}   unreachable/429/empty (excluded): ${unreachable} (direct 429: ${direct429}, net-fail: ${proxyFail})`);
    console.log(`credited (any non-platform builder credit): ${credited}`);
    console.log(`INCIDENCE: ${pct(o.p)}  (95% CI ${pct(o.lo)}–${pct(o.hi)}, ±${pct(o.moe)}, n=${fetched})`);
    console.log(`\nby SIGNAL (share of fetched where this signal fired; a store can fire several):`);
    for (const [s, n] of Object.entries(sigCount).sort((a, b) => b[1] - a[1])) console.log(`  ${s.padEnd(16)} ${n}  (${pct(n / fetched)})`);
    console.log(`  (credited stores whose credit matched a KNOWN partner: ${matchedKnown})`);
    console.log(`\nby PLATFORM:`);
    for (const [p, v] of Object.entries(byPlat).sort((a, b) => b[1].fetched - a[1].fetched)) {
      const c = ci95(v.credited, v.fetched);
      console.log(`  ${p.padEnd(14)} fetched ${String(v.fetched).padStart(5)}  credited ${String(v.credited).padStart(4)}  ${pct(c.p)}  (95% CI ${pct(c.lo)}–${pct(c.hi)})`);
    }
    console.log(`\nunknown agencies flagged (${candNames.size}):`);
    console.log("  " + [...candNames.entries()].slice(0, 40).map(([n, v]) => `${n} (${v.host})`).join("; "));
  } finally { closeAgents(); await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
