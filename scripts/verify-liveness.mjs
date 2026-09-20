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
const MIGRATE_AFTER = 2;   // consecutive reachable-but-not-Shopify checks before "migrated"
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const LIMIT = parseInt(opt("--limit", "0"), 10);          // 0 = all due
const CONCURRENCY = parseInt(opt("--concurrency", "8"), 10);
const MIN_AGE_DAYS = parseInt(opt("--min-age-days", "14"), 10);
// --country ZA,KE,NG,JP restricts churn monitoring to markets we sell into. Global bare-record
// stores are banked for later, not liveness-tracked now (they'd drown the sold markets).
const COUNTRIES = (opt("--country", "") || "").toUpperCase().split(",").map((s) => s.trim()).filter(Boolean);

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set (run with --env-file=.env.local)");
  process.exit(2);
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

async function getOnce(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
    });
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Retry transient failures (timeout/refused) — a single blip shouldn't read as
// "unreachable". Note: from a datacenter IP, Shopify's edge rate-limits hard, so
// for a trustworthy liveness read run this from a residential IP + low concurrency.
async function get(url, timeoutMs = 9000, attempts = 3) {
  for (let a = 0; a < attempts; a++) {
    const res = await getOnce(url, timeoutMs);
    if (res) return res;
    if (a < attempts - 1) await new Promise((r) => setTimeout(r, 500 * (a + 1)));
  }
  return null;
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
  Magento: ["/pub/static/version", "data-mage-init"],   // Adobe Commerce
  "Salesforce Commerce Cloud": ["/on/demandware.store", "demandware.static", "dwstatic", "demandware.edgesuite"],  // ex-Demandware
  Cafe24: ["cafe24.com", "echosting.cafe24", "sdeqoo"],   // Korean platform, big in KR/JP
  BASE: ["thebase.in", "base-ec.com", "static.base.ec", "binbase"],   // BASE (ベイス) — JP SMB platform
  Webflow: ["webflow.com", "assets.website-files.com"],
  PrestaShop: ["prestashop", "/modules/ps_", "id_product_attribute", "prestashop-"],
  Odoo: ["data-oe-model", "web.assets_frontend", "/web/static/lib", "odoo.define"],
  Ecwid: ["app.ecwid.com"],
  "EC-CUBE": ["ec-cube", "eccube", "ec-layoutrole", "/html/template/default"],   // dominant JP self-hosted platform
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

import { resolve4 } from "node:dns/promises";

async function dnsResolves(domain) {
  try {
    const ips = await resolve4(domain);
    return ips.length ? ips : null;
  } catch {
    return null;
  }
}

/** Returns { reachable, shopify, platform, dnsDead }. */
async function classify(domain) {
  // Cheapest signal first: does it serve a Shopify catalogue?
  const pj = await get(`https://${domain}/products.json?limit=1`);
  if (pj && pj.ok) {
    try {
      const j = await pj.json();
      if (Array.isArray(j.products) && j.products.length > 0)
        // `selling: true` = the ONLY genuine "confirmed live + selling" signal (a real product
        // catalogue). Only this stamps last_alive_at, so a churn's died_at is dated to when the
        // store was last actually SELLING — not merely when its homepage was up.
        return { reachable: true, shopify: true, platform: "Shopify", selling: true };
    } catch { /* not json — fall through to homepage */ }
  }
  // Shopify returns 402 Payment Required when a store is FROZEN for an unpaid Shopify bill: it's
  // commercially churned (not accepting orders) even though its homepage usually still serves
  // Shopify markers — which would otherwise read as "active" and hide the churn. Treat it as a
  // non-live miss so the 2-miss rule churns it out. Self-correcting: if the merchant pays up, the
  // next sweep sees products.json 200 → active again. (This is the bulk of the `no_variant` tail:
  // the checkout probe couldn't cart a product precisely because the store is frozen.)
  if (pj && pj.status === 402)
    return { reachable: false, shopify: false, platform: null, frozen: true };
  // Otherwise decide via the homepage.
  const home = await get(`https://${domain}`);
  if (!home) {
    // HTTP failed — DNS tells dead (domain gone) from throttled (still resolves).
    const ips = await dnsResolves(domain);
    if (!ips) return { reachable: false, shopify: false, platform: null, dnsDead: true };
    if (ips.some((ip) => ip.startsWith("23.227.38."))) // Shopify's range
      return { reachable: true, shopify: true, platform: "Shopify" };
    return { reachable: false, shopify: false, platform: null }; // resolves but HTTP-throttled
  }
  // A homepage that 404s/410s is gone — route to the dead path (still 2-miss protected), not the
  // ambiguous "reachable but unknown platform" path (which we now keep active to avoid false churn).
  if (home.status === 404 || home.status === 410)
    return { reachable: false, shopify: false, platform: null };
  let html = "";
  try { html = await home.text(); } catch { html = ""; }
  const headerBlob = [...home.headers.entries()].map(([k, v]) => `${k}:${v}`).join(" ");
  const platform = detectPlatform(html, headerBlob);
  if (platform === "Shopify") return { reachable: true, shopify: true, platform: "Shopify" };
  return { reachable: true, shopify: false, platform };
}

function nextStatus(old, miss, { reachable, shopify, dnsDead, frozen, platform }) {
  // A single bad check is not churn. A store can throw one timeout, one DNS blip, a
  // Cloudflare/WAF interstitial, or a maintenance page and still be perfectly alive — so
  // the reachable/migrated terminal states require DEAD_AFTER/MIGRATE_AFTER consecutive
  // confirming misses before we log churn. Any healthy (reachable + Shopify) check resets the
  // counter. The old code flipped "migrated" on the very first non-Shopify response (miss reset
  // to 0), which logged ~2,300 false "migrated → unknown" churns and pulled live stores out.
  if (shopify) return { status: "active", miss: 0 };                       // healthy → reset
  // EXCEPTION: a 402 "frozen" is Shopify itself suspending the store for a non-payment — a
  // definitive commercial-churn signal, not a transient blip — so it flips on first confirmation.
  // Self-correcting: if the merchant pays up, the next sweep sees products.json 200 → active.
  if (frozen) return { status: "dead", miss: miss + 1 };
  if (dnsDead || !reachable) return { status: miss + 1 >= DEAD_AFTER ? "dead" : (old || "active"), miss: miss + 1 };
  // Reachable but not Shopify. Only call it a MIGRATION when we POSITIVELY identified the new
  // platform (Woo/Wix/…). A reachable page with NO identifiable platform is ambiguous — most
  // often a Cloudflare/WAF challenge or a parked/maintenance page masking a still-live Shopify
  // store — so we must NOT churn it (that's the "migrated → unknown" false-positive that pulled
  // ~640 live stores out of the base). Keep it active and wait for a clearer signal.
  if (platform) return { status: miss + 1 >= MIGRATE_AFTER ? "migrated" : (old || "active"), miss: miss + 1 };
  return { status: "active", miss: 0 };
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: Math.min(CONCURRENCY, 8) });
  try {
    // Ensure the live_* columns exist (idempotent).
    await sql.unsafe(readFileSync(new URL("../lib/schema.sql", import.meta.url), "utf8"));

    const cutoff = new Date(Date.now() - MIN_AGE_DAYS * 864e5).toISOString();
    // --from-file <path>: re-check exactly this domain list (one per line), ignoring the value-rank
    // + min-age. Lets us aim a liveness pass at a specific bucket (e.g. the no_variant tail, to churn
    // out the dead/frozen stores that are dragging down real coverage) instead of the whole base.
    const fromFile = opt("--from-file", "");
    let rows;
    if (fromFile) {
      const doms = readFileSync(fromFile, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
      rows = await sql`
        SELECT domain, live_miss FROM imported_stores
        WHERE domain = ANY(${doms})
          ${COUNTRIES.length ? sql`AND UPPER(country) = ANY(${COUNTRIES})` : sql``}
        ORDER BY estimated_monthly_sales DESC NULLS LAST
        ${LIMIT > 0 ? sql`LIMIT ${LIMIT}` : sql``}`;
      console.log(`Verifying ${rows.length.toLocaleString()} stores from ${fromFile}…`);
    } else {
      rows = await sql`
        SELECT domain, live_miss FROM imported_stores
        WHERE published AND (live_checked_at IS NULL OR live_checked_at < ${cutoff})
          ${COUNTRIES.length ? sql`AND UPPER(country) = ANY(${COUNTRIES})` : sql``}
        ORDER BY estimated_monthly_sales DESC NULLS LAST
        ${LIMIT > 0 ? sql`LIMIT ${LIMIT}` : sql``}`;
      console.log(`Verifying ${rows.length.toLocaleString()} stores (highest value first)…`);
    }

    const tally = { active: 0, migrated: 0, dead: 0 };
    let done = 0, i = 0;

    let skipped = 0;
    async function persist(domain, status, res, miss, attempt = 0) {
      try {
        await sql`
          UPDATE imported_stores SET
            live_status = ${status},
            live_platform = ${res.platform},
            live_miss = ${miss},
            live_checked_at = now(),
            -- Stamp the first time we CONFIRM this store live (never overwrite it).
            -- This is the anchor that separates real churn from historic die-off.
            first_verified_live_at = CASE WHEN ${status} = 'active'
              THEN COALESCE(first_verified_live_at, now()) ELSE first_verified_live_at END,
            -- Stamp the LAST time we confirm it SELLING (products.json returned a catalogue) — not
            -- merely homepage-up. On any other check we leave it as-is, so it holds the last-known-
            -- selling time = our death-date estimate for the churn below (undatable when never sold).
            last_alive_at = CASE WHEN ${res.selling === true} THEN now() ELSE last_alive_at END
          WHERE domain = ${domain}`;
        // Snapshot into the churn log the moment a store is confirmed gone —
        // preserving what it was using. First churn wins (ON CONFLICT DO NOTHING).
        // `historic` = we never verified it live before it died (dead at first
        // contact, e.g. a bulk-imported old site) → excluded from period churn.
        if (status === "dead" || status === "migrated") {
          await sql`
            INSERT INTO churn_log (domain, name, country, status, migrated_to, first_seen,
              discovered_at, category, theme, city, estimated_monthly_sales, payments,
              shipping_providers, free_shipping, plus, historic, died_at)
            SELECT domain, name, country, ${status}, ${res.platform}, first_seen,
              discovered_at, category, theme, city, estimated_monthly_sales, payments,
              shipping_providers, free_shipping, plus, (first_verified_live_at IS NULL),
              -- Real death date estimate = last time we confirmed it live. NULL when we never
              -- did (undatable die-off) → excluded from period churn on the market's clock.
              last_alive_at
            FROM imported_stores WHERE domain = ${domain}
            ON CONFLICT (domain) DO NOTHING`;
        }
        return true;
      } catch (e) {
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          return persist(domain, status, res, miss, attempt + 1);
        }
        return false; // leave unchecked — a later run retries it
      }
    }

    async function worker() {
      while (i < rows.length) {
        const { domain, live_miss } = rows[i++];
        const res = await classify(domain).catch(() => ({ reachable: false, shopify: false, platform: null }));
        const { status, miss } = nextStatus(null, live_miss || 0, res);
        if (await persist(domain, status, res, miss)) {
          tally[status] = (tally[status] || 0) + 1;
        } else {
          skipped++;
        }
        if (++done % 100 === 0)
          process.stdout.write(`\r  ${done.toLocaleString()} / ${rows.length.toLocaleString()}  (active ${tally.active}, migrated ${tally.migrated}, dead ${tally.dead}${skipped ? `, skipped ${skipped}` : ""})`);
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
