#!/usr/bin/env node
/**
 * Radar monitoring sweep — the always-on half of Radar.
 *
 * Compares cached store fingerprints against enrolled brand fingerprints
 * (radar_brands) and records clone detections (radar_detections). This is what
 * turns a one-off audit into ongoing protection: once a brand is on file, every
 * newly-fingerprinted store is checked against it automatically.
 *
 *   node --env-file=.env.local scripts/radar-monitor.mjs           # incremental
 *   node --env-file=.env.local scripts/radar-monitor.mjs --all     # full re-scan
 *   node --env-file=.env.local scripts/radar-monitor.mjs --since 14 --min 30
 *
 * Incremental logic (the default): a brand fingerprinted in the last N days is
 * compared against ALL stores (catch clones that predate enrolment); an older
 * brand is compared only against stores fingerprinted in the last N days (catch
 * newly-discovered clones). --all compares every brand against every store.
 *
 * Pure computation over already-cached fingerprints — no merchant fetches — so
 * it's cheap and safe to run often. Scoring MIRRORS lib/radar/catalog.ts; keep
 * the weights below in sync if that file changes.
 */

import postgres from "postgres";

const ALL = process.argv.includes("--all");
const sinceArg = process.argv.indexOf("--since");
const SINCE_DAYS = sinceArg > -1 ? Number(process.argv[sinceArg + 1]) : 7;
const minArg = process.argv.indexOf("--min");
const MIN_SCORE = minArg > -1 ? Number(process.argv[minArg + 1]) : 25;

// --- scoring (mirrors lib/radar/catalog.ts) ---------------------------------
const W_IMAGE = 34, W_SKU = 26, W_HANDLE = 22, W_TITLE = 18;

function containment(a, b) {
  if (a.size === 0 || b.size === 0) return [0, 0];
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const x of small) if (large.has(x)) inter++;
  return [inter / small.size, inter];
}

const verdictFor = (s) => (s >= 75 ? "COPY" : s >= 50 ? "LIKELY" : s >= 25 ? "PARTIAL" : "clean");

function compare(brand, suspect) {
  if (!brand.n || !suspect.n) return null;
  const [imgR, imgN] = containment(brand.imageStems, suspect.imageStems);
  const [skuR, skuN] = containment(brand.skus, suspect.skus);
  const [hndR, hndN] = containment(brand.handles, suspect.handles);
  const [ttlR, ttlN] = containment(brand.titles, suspect.titles);

  const matched = [...brand.handles].filter((h) => suspect.handles.has(h));
  const priced = matched.filter((h) => brand.priceByHandle.has(h) && suspect.priceByHandle.has(h));
  let priceMirror = 0;
  if (priced.length) {
    const same = priced.filter(
      (h) => Math.abs(brand.priceByHandle.get(h) - suspect.priceByHandle.get(h)) < 0.01,
    ).length;
    priceMirror = same / priced.length;
  }

  let score = W_IMAGE * imgR + W_SKU * skuR + W_HANDLE * hndR + W_TITLE * ttlR;
  score *= 1 + 0.15 * priceMirror;
  score = Math.min(100, Math.round(score));

  const pct = (r) => `${Math.round(r * 100)}%`;
  const reasons = [];
  if (imgN) reasons.push(`${imgN} identical product images (${pct(imgR)} of the smaller catalogue)`);
  if (skuN) reasons.push(`${skuN} identical SKUs`);
  if (hndN) reasons.push(`${hndN} identical product handles`);
  if (ttlN) reasons.push(`${ttlN} identical product titles`);
  if (priceMirror) reasons.push(`prices mirrored on ${pct(priceMirror)} of shared products`);

  return { score, verdict: verdictFor(score), reasons };
}

const toFp = (r) => ({
  n: r.n_products,
  imageStems: new Set(r.image_stems),
  skus: new Set(r.skus),
  handles: new Set(r.handles),
  titles: new Set(r.titles),
  priceByHandle: new Map(Object.entries(r.price_by_handle || {})),
});

// Email brands (with active monitoring) about NEW detections they haven't been
// alerted on. One email per brand summarising the fresh clones. Idempotent via
// radar_detections.alerted_at. Needs RESEND_API_KEY (Mac has it; the GitHub
// Actions runner skips unless the secret is added there too).
async function sendAlerts(sql) {
  const KEY = process.env.RESEND_API_KEY;
  const FROM = process.env.EMAIL_FROM || "Radar <onboarding@resend.dev>";
  if (!KEY) { console.log("alerts: no RESEND_API_KEY — skipping"); return; }

  const rows = await sql`
    SELECT d.brand_domain, b.brand_name, b.email, d.suspect, d.verdict, d.score
    FROM radar_detections d
    JOIN radar_brands b ON b.brand_domain = d.brand_domain
    WHERE d.alerted_at IS NULL
      AND b.subscription_status IN ('active', 'trialing')
      AND b.email IS NOT NULL AND b.email <> ''
      AND d.score >= ${MIN_SCORE}
    ORDER BY d.brand_domain, d.score DESC`;
  if (!rows.length) { console.log("alerts: no new detections for subscribed brands"); return; }

  const byBrand = new Map();
  for (const r of rows) {
    if (!byBrand.has(r.brand_domain)) {
      byBrand.set(r.brand_domain, { email: r.email, name: r.brand_name || r.brand_domain, brand: r.brand_domain, hits: [] });
    }
    byBrand.get(r.brand_domain).hits.push(r);
  }

  let sent = 0;
  for (const g of byBrand.values()) {
    const n = g.hits.length;
    const list = g.hits.slice(0, 10).map((h) => `• ${h.suspect} — ${h.verdict} (score ${h.score})`).join("\n");
    const subject = `Radar: ${n} new store${n === 1 ? "" : "s"} copying ${g.name}`;
    const text = `Radar detected ${n} new store${n === 1 ? "" : "s"} reproducing ${g.name}'s catalogue:\n\n${list}\n\nSee the full evidence and take action:\nhttps://radar.tembocommerce.app/dashboard\n\n— Radar, part of Tembo Commerce`;
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:540px;margin:0 auto;padding:32px 24px;color:#0f2b2a">
      <p style="font-size:22px;margin:0 0 16px">◎ <strong>Radar</strong> alert</p>
      <p style="color:#4a5f5e;line-height:1.6;margin:0 0 20px">We detected <strong>${n} new store${n === 1 ? "" : "s"}</strong> reproducing <strong>${g.name}</strong>'s catalogue:</p>
      <ul style="color:#0f2b2a;line-height:1.9;margin:0 0 24px;padding-left:18px">
        ${g.hits.slice(0, 10).map((h) => `<li><code>${h.suspect}</code> — ${h.verdict} · ${h.score}</li>`).join("")}
      </ul>
      <a href="https://radar.tembocommerce.app/dashboard" style="display:inline-block;background:#4cc9d4;color:#0c2b30;text-decoration:none;padding:14px 28px;border-radius:999px;font-weight:600">See the evidence →</a>
      <p style="color:#8a9a99;font-size:13px;line-height:1.6;margin:28px 0 0">Radar, part of Tembo Commerce · You're receiving this because monitoring is active for ${g.name}.</p>
    </div>`;
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: FROM, to: [g.email], subject, html, text }),
      });
      if (!res.ok) { console.log(`  ! alert to ${g.email} failed: ${res.status}`); continue; }
      await sql`UPDATE radar_detections SET alerted_at = now() WHERE brand_domain = ${g.brand} AND alerted_at IS NULL`;
      sent++;
      console.log(`  ✉ alerted ${g.email} — ${n} new for ${g.name}`);
    } catch (e) { console.log(`  ! alert error: ${e.message}`); }
  }
  console.log(`alerts: ${sent} email(s) sent`);
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3 });
  try {
    await sql`SELECT 1`; // fail fast on a bad DATABASE_URL
    await sql`ALTER TABLE radar_detections ADD COLUMN IF NOT EXISTS alerted_at TIMESTAMPTZ`;
    const brands = await sql`
      SELECT brand_domain, brand_name, market, official_domains, n_products,
             image_stems, skus, handles, titles, price_by_handle, fingerprinted_at
      FROM radar_brands WHERE monitoring AND n_products > 0`;
    if (!brands.length) { console.log("No monitored brands enrolled — nothing to sweep."); await sendAlerts(sql); return; }

    const cutoff = new Date(Date.now() - SINCE_DAYS * 864e5);
    console.log(`Sweeping ${brands.length} brand(s)${ALL ? " [full re-scan]" : ` (incremental, ${SINCE_DAYS}d)`}, min score ${MIN_SCORE}…\n`);

    let comparisons = 0, hits = 0;
    for (const b of brands) {
      const brandFp = toFp(b);
      const allow = new Set(b.official_domains || []);
      // Recent brand (or --all) → scan every store; older brand → recent stores only.
      const brandIsRecent = ALL || new Date(b.fingerprinted_at) >= cutoff;
      const stores = brandIsRecent
        ? await sql`SELECT domain, name, n_products, image_stems, skus, handles, titles, price_by_handle
                    FROM store_fingerprints WHERE status = 'ok' AND market = ${b.market}`
        : await sql`SELECT domain, name, n_products, image_stems, skus, handles, titles, price_by_handle
                    FROM store_fingerprints WHERE status = 'ok' AND market = ${b.market}
                      AND enriched_at >= ${cutoff}`;

      let brandHits = 0;
      for (const s of stores) {
        if (allow.has(s.domain)) continue; // the brand's own / authorised stores
        comparisons++;
        const rep = compare(brandFp, toFp(s));
        if (!rep || rep.score < MIN_SCORE) continue;
        await sql`
          INSERT INTO radar_detections (
            brand_domain, suspect, brand_name, suspect_name, verdict, score, reasons, last_seen_at
          ) VALUES (
            ${b.brand_domain}, ${s.domain}, ${b.brand_name}, ${s.name},
            ${rep.verdict}, ${rep.score}, ${sql.json(rep.reasons)}, now()
          )
          ON CONFLICT (brand_domain, suspect) DO UPDATE SET
            verdict = EXCLUDED.verdict, score = EXCLUDED.score, reasons = EXCLUDED.reasons,
            suspect_name = EXCLUDED.suspect_name, last_seen_at = now()`;
        hits++; brandHits++;
        console.log(`  ⚑ ${s.domain}  →  copying ${b.brand_domain}  [${rep.verdict} ${rep.score}]`);
      }
      console.log(`— ${b.brand_domain}: ${stores.length} store(s) checked, ${brandHits} detection(s)`);
    }
    console.log(`\nDone. ${comparisons} comparisons, ${hits} detection(s) recorded/refreshed.`);
    await sendAlerts(sql);
  } finally { await sql.end(); }
}

main().catch((e) => { console.error("failed:", e.message); process.exit(1); });
