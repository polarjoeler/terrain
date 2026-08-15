#!/usr/bin/env node
/**
 * Value-ranked liveness sweep over imported_stores.
 *
 *   node --env-file=.env.local scripts/verify-liveness.mjs [--limit N] [--concurrency 12]
 *
 * Works top-down by estimated_monthly_sales, so the highest-value merchants are
 * verified first (interrupt any time — the head is already done). Classifies:
 *   active   — /products.json serves a catalogue (live Shopify)
 *   migrated — reachable, but no longer Shopify (records the platform)
 *   dead     — unreachable across 2 consecutive checks
 * Resumable: skips anything checked within --min-age-days.
 */

import { readFileSync } from "node:fs";
import postgres from "postgres";

const DEAD_AFTER = 2;
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const LIMIT = parseInt(opt("--limit", "0"), 10);          // 0 = all due
const CONCURRENCY = parseInt(opt("--concurrency", "12"), 10);
const MIN_AGE_DAYS = parseInt(opt("--min-age-days", "14"), 10);

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set (run with --env-file=.env.local)");
  process.exit(2);
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

async function get(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
    });
    return res;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// HTML + response-header signals. The header ones catch headless / bot-walled
// Shopify stores that hide the usual HTML markers.
const SHOPIFY_MARKERS = [
  "cdn.shopify.com", "shopify.theme", "/cdn/shop/", "myshopify.com",
  "x-shopid", "x-sorting-hat-shopid", "x-shardid", "x-shopify-stage",
  "powered-by:shopify",
];
const PLATFORMS = {
  WooCommerce: ["woocommerce", "wp-content/plugins/woocommerce", "wc-ajax"],
  WordPress: ["wp-content", "wp-json"],
  Wix: ["wixstatic.com", "parastorage.com", "_wixcssimports"],
  Squarespace: ["squarespace.com", "static1.squarespace"],
  BigCommerce: ["bigcommerce.com", "stencil-utils"],
  Magento: ["/pub/static/version", "data-mage-init"],
  Webflow: ["webflow.com", "assets.website-files.com"],
  Ecwid: ["app.ecwid.com"],
  "Square Online": ["squareup.com", "weeblycloud"],
};

function detectPlatform(html, headerBlob) {
  const hay = (html + " " + headerBlob).toLowerCase();
  if (SHOPIFY_MARKERS.some((m) => hay.includes(m))) return "Shopify";
  let best = null, bestHits = 0;
  for (const [name, needles] of Object.entries(PLATFORMS)) {
    const hits = needles.filter((n) => hay.includes(n)).length;
    if (hits > bestHits) { best = name; bestHits = hits; }
  }
  return best; // may be null (custom / parked)
}

/** Returns { reachable, shopify, platform }. */
async function classify(domain) {
  // Cheapest signal first: does it serve a Shopify catalogue?
  const pj = await get(`https://${domain}/products.json?limit=1`);
  if (pj && pj.ok) {
    try {
      const j = await pj.json();
      if (Array.isArray(j.products) && j.products.length > 0)
        return { reachable: true, shopify: true, platform: "Shopify" };
    } catch { /* not json — fall through to homepage */ }
  }
  // Otherwise decide via the homepage.
  const home = await get(`https://${domain}`);
  if (!home) return { reachable: false, shopify: false, platform: null };
  let html = "";
  try { html = await home.text(); } catch { html = ""; }
  const headerBlob = [...home.headers.entries()].map(([k, v]) => `${k}:${v}`).join(" ");
  const platform = detectPlatform(html, headerBlob);
  if (platform === "Shopify") return { reachable: true, shopify: true, platform: "Shopify" };
  return { reachable: true, shopify: false, platform };
}

function nextStatus(old, miss, { reachable, shopify }) {
  if (!reachable) return { status: miss + 1 >= DEAD_AFTER ? "dead" : (old || "active"), miss: miss + 1 };
  if (shopify) return { status: "active", miss: 0 };
  return { status: "migrated", miss: 0 };
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: Math.min(CONCURRENCY, 8) });
  try {
    // Ensure the live_* columns exist (idempotent).
    await sql.unsafe(readFileSync(new URL("../lib/schema.sql", import.meta.url), "utf8"));

    const cutoff = new Date(Date.now() - MIN_AGE_DAYS * 864e5).toISOString();
    const rows = await sql`
      SELECT domain, live_miss FROM imported_stores
      WHERE published AND (live_checked_at IS NULL OR live_checked_at < ${cutoff})
      ORDER BY estimated_monthly_sales DESC NULLS LAST
      ${LIMIT > 0 ? sql`LIMIT ${LIMIT}` : sql``}
    `;
    console.log(`Verifying ${rows.length.toLocaleString()} stores (highest value first)…`);

    const tally = { active: 0, migrated: 0, dead: 0 };
    let done = 0, i = 0;

    async function worker() {
      while (i < rows.length) {
        const { domain, live_miss } = rows[i++];
        const res = await classify(domain).catch(() => ({ reachable: false, shopify: false, platform: null }));
        const { status, miss } = nextStatus(null, live_miss || 0, res);
        await sql`
          UPDATE imported_stores SET
            live_status = ${status},
            live_platform = ${res.platform},
            live_miss = ${miss},
            live_checked_at = now()
          WHERE domain = ${domain}`;
        tally[status] = (tally[status] || 0) + 1;
        if (++done % 100 === 0)
          process.stdout.write(`\r  ${done.toLocaleString()} / ${rows.length.toLocaleString()}  (active ${tally.active}, migrated ${tally.migrated}, dead ${tally.dead})`);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
    process.stdout.write("\n");

    const total = tally.active + tally.migrated + tally.dead;
    console.log(`✓ Done. active ${tally.active.toLocaleString()} · migrated ${tally.migrated.toLocaleString()} · dead ${tally.dead.toLocaleString()}`);
    if (total) console.log(`  verified survival: ${((100 * tally.active) / total).toFixed(1)}%`);
  } finally {
    await sql.end();
  }
}

main().catch((e) => { console.error("\nliveness sweep failed:", e.message); process.exit(1); });
