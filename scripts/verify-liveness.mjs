#!/usr/bin/env node
/**
 * Value-ranked liveness sweep over imported_stores.
 *
 *   node --env-file=.env.local scripts/verify-liveness.mjs [--limit N] [--concurrency 12]
 *
 * Works top-down by estimated_monthly_sales, so the highest-value merchants are
 * verified first (interrupt any time — the head is already done). Classifies:
 *   active   — /products.json serves a catalogue (live Shopify)
 *   migrated — reachable, and positively identified as a DIFFERENT platform than we recorded
 *   dead     — unreachable across 2 consecutive checks, or a FROZEN (402) storefront on one
 * Resumable: skips anything THIS LANE checked within --min-age-days — except a store carrying a
 * banked 402 from contact-enrich, which jumps the queue (see FROZEN-FIRST below).
 *
 * THIS LANE's clock is verified_checked_at, not live_checked_at. 13 scripts write
 * live_checked_at, most of them asking a far weaker question — a DNS answer proves a domain
 * resolves, not that a storefront sells — so 18,349 published focus-market stores were reading as
 * "checked within 7 days" and hiding from the queue below, which is the only one that sees frozen
 * 402s and confirmed migrations. Measured 2026-11-18: NONE of this lane's top 600 stores by
 * store_priority was due, on a 7-day gate, because other lanes refresh the shared clock on them
 * every ~3 days. FROZEN-FIRST below is the same bug met from the other side, for the 402 subset.
 * Both columns are still stamped on every check here.
 *
 * SHOPIFY-ONLY, and the queue enforces it. The liveness signal here IS /products.json, which only
 * Shopify serves — so a WooCommerce store cannot pass the `active` test no matter how healthy it
 * is. It reads as "reachable, not Shopify, platform identified = WooCommerce" and was therefore
 * marked `migrated`, which both logs a fake churn event and pulls the store out of the
 * customer-visible base (lib/browse.ts excludes dead/migrated). Non-Shopify liveness needs a
 * platform-appropriate probe — for Woo that is the Store API already used by scripts/lib/woo-catalog.mjs.
 */

import { readFileSync } from "node:fs";
import postgres from "postgres";
import { applySchema } from "../lib/ensure-schema.ts";
import { logChurn } from "./lib/churn.mjs";

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
  // Africa-first + cross-border builders the global vendors miss (added 2026-10-29; mirror of
  // shopify-radar/woo_probe.py _CMS_FINGERPRINTS). Selar/Catlog are path-based (selar.com/m/…,
  // catlog.shop/…) so they carry no own-domain markers — found via the sitemap lane, not here.
  Shoplazza: ["myshoplaza.com", "static.staticdj.com", "shoplazza"],   // China cross-border (Africa push)
  Shopline: ["myshopline.com", "shoplinecdn.com", "shoplineapp.com"],  // HK/SEA omnichannel
  Bumpa: ["bumpa.shop", "getbumpa.com"],                               // Nigeria SME builder
  Gumroad: ["gumroad.com"],                                            // creator commerce (+ Rippl supply)
  Payhip: ["payhip.com"],                                              // creator/digital commerce
  "Paystack Storefront": ["paystack.shop"],                            // NG/GH/ZA payment-provider storefront (path-based)
  "Flutterwave Store": ["flutterwave.store"],                          // NG/Africa SME storefront
  Medusa: ["medusajs", "medusa-react", "x-medusa-"],                   // headless open-source
  Bagisto: ["/vendor/webkul/", "bagisto"],                             // open-source Laravel commerce
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
  // The SAME frozen signal as the products.json 402 above, on the request we actually get an
  // answer from. This has to be checked HERE, before detectPlatform: a frozen store's 402 page is
  // still served by Shopify's edge, complete with cdn.shopify.com assets and the x-shopid header,
  // so it matches SHOPIFY_MARKERS and fell straight through to the `platform === "Shopify"` line
  // below — which reads as healthy and RESETS live_miss to 0. The products.json 402 never caught
  // it in practice either, because that endpoint is the one Shopify rate-limits hardest (429 on
  // ~9 of 10 attempts), so the 402 arrived as a 429 and was skipped. Net effect measured on
  // 2026-11-18: 4,072 published stores whose storefront answers 402 were still live_status
  // 'active' — re-confirmed as healthy by the very lane meant to churn them, and served to
  // customers as live leads. Self-correcting, as above: pay the bill and the next sweep sees a
  // 200 → active.
  if (home.status === 402)
    return { reachable: false, shopify: false, platform: null, frozen: true };
  let html = "";
  try { html = await home.text(); } catch { html = ""; }
  const headerBlob = [...home.headers.entries()].map(([k, v]) => `${k}:${v}`).join(" ");
  const platform = detectPlatform(html, headerBlob);
  if (platform === "Shopify") return { reachable: true, shopify: true, platform: "Shopify" };
  return { reachable: true, shopify: false, platform };
}

function nextStatus(old, miss, { reachable, shopify, dnsDead, frozen, platform }, knownPlatform = null) {
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
  //
  // AND the platform has to have CHANGED. Identifying "WooCommerce" on a store we already recorded
  // as WooCommerce is not a migration, it is this Shopify-only probe meeting a non-Shopify store —
  // yet it used to return "migrated", logging fake churn and removing a live store from the base.
  // This is the third incarnation of the same false-positive (first on a single non-Shopify
  // response, then on "migrated → unknown"), so the guard lives HERE rather than only in the
  // queue: --from-file feeds in arbitrary domains and bypasses any queue-level filter.
  // A migration needs a BEFORE as well as an after. With no recorded platform we never knew the
  // store was Shopify, so identifying one now is a CLASSIFICATION, not a move — live_platform is
  // still written (the data improves) but the store stays active rather than churning.
  const moved = !!platform && !!knownPlatform && platform.toLowerCase() !== knownPlatform.toLowerCase();
  if (moved) return { status: miss + 1 >= MIGRATE_AFTER ? "migrated" : (old || "active"), miss: miss + 1 };
  return { status: "active", miss: 0 };
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: Math.min(CONCURRENCY, 8) });
  try {
    // Ensure the live_* columns exist. GUARDED, not replayed: lib/schema.sql is 143 statements
    // (90 ADD COLUMN, 19 CREATE TABLE, 34 CREATE INDEX) and `IF NOT EXISTS` is evaluated while
    // already HOLDING ACCESS EXCLUSIVE, not before taking it — so applying the file raw queues 143
    // no-op strong-lock requests on imported_stores, and a pending strong lock request blocks every
    // lock requested after it. That stalls the enrichment scans and the web app behind a startup
    // check that changes nothing (~83s per no-op ALTER under load, measured in #91/#92).
    // applySchema reads the catalog first, which takes no lock on any of those tables, and runs
    // only what is genuinely missing: 0 statements on an already-migrated database.
    const schema = await applySchema(
      sql,
      readFileSync(new URL("../lib/schema.sql", import.meta.url), "utf8"),
    );
    if (schema.ran) console.log(`  schema: ${schema.ran} statement(s) applied, ${schema.skipped} already present`);

    const cutoff = new Date(Date.now() - MIN_AGE_DAYS * 864e5).toISOString();
    // --from-file <path>: re-check exactly this domain list (one per line), ignoring the value-rank
    // + min-age. Lets us aim a liveness pass at a specific bucket (e.g. the no_variant tail, to churn
    // out the dead/frozen stores that are dragging down real coverage) instead of the whole base.
    const fromFile = opt("--from-file", "");
    let rows;
    // Biggest first by the shared priority score (scripts/build-priority.mjs), the same order the
    // payments, contact and render lanes use since #136. It replaces raw estimated_monthly_sales,
    // which is each store's LOCAL currency (a rand figure beat a dollar one 18 to 1) and empty on
    // ~63% of rows — so with a 300-store budget per run this lane was spending it on a near-random
    // slice. store_priority only ranks stores believed LIVE, so an already-dead store has no row
    // and sorts last on the fallback, which is the right order for a re-check anyway.
    const hasPriority = !!(await sql`SELECT to_regclass('public.store_priority') t`)[0].t;
    const sizeOrder = hasPriority
      ? sql`(SELECT p.account_score FROM store_priority p WHERE p.domain = imported_stores.domain) DESC NULLS LAST, estimated_monthly_sales DESC NULLS LAST`
      : sql`estimated_monthly_sales DESC NULLS LAST`;

    if (fromFile) {
      const doms = readFileSync(fromFile, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
      rows = await sql`
        SELECT domain, live_miss, platform FROM imported_stores
        WHERE domain = ANY(${doms})
          ${COUNTRIES.length ? sql`AND UPPER(country) = ANY(${COUNTRIES})` : sql``}
        ORDER BY ${sizeOrder}
        ${LIMIT > 0 ? sql`LIMIT ${LIMIT}` : sql``}`;
      console.log(`Verifying ${rows.length.toLocaleString()} stores from ${fromFile}…`);
    } else {
      rows = await sql`
        SELECT domain, live_miss, platform FROM imported_stores
        WHERE published AND (verified_checked_at IS NULL OR verified_checked_at < ${cutoff})
          -- Shopify (or not yet classified) only: see the SHOPIFY-ONLY note in the header. Without
          -- this the queue holds ~58,000 non-Shopify stores in the sold markets — 46,339 of them
          -- WooCommerce, the half Partner is sold on — every one of which this probe would read as
          -- a migration and drop from the customer base.
          AND (platform IS NULL OR lower(platform) = 'shopify')
          -- ...and a storefront at all. not_a_store rows are a parked install, or an infrastructure
          -- / customer-account hostname of a store we already track (mail./account./cpanel.).
          -- Asking whether a mail host is "live" spends the one residential IP's budget on a
          -- question with no answer worth having — and they sorted HIGH here, because they inherit
          -- their account's score from store_priority.
          AND activity_tier IS DISTINCT FROM 'not_a_store'
          ${COUNTRIES.length ? sql`AND UPPER(country) = ANY(${COUNTRIES})` : sql``}
        ORDER BY ${sizeOrder}
        ${LIMIT > 0 ? sql`LIMIT ${LIMIT}` : sql``}`;
      console.log(`Verifying ${rows.length.toLocaleString()} stores (biggest first)…`);

      // FROZEN-FIRST. contact-enrich records storefront_http on every crawl specifically so this
      // lane can act on a 402 (see its note: "Deliberately NOT written to live_status — churn
      // accounting has historic-vs-forward rules that belong to that lane, so this just banks the
      // observation for it to act on"). Nothing ever read it back. Meanwhile a frozen store's last
      // liveness check is usually recent — it was wrongly passed as 'active', see liveness() — so
      // it sits INSIDE --min-age-days and the ordinary queue above never reaches it. The banked
      // signal therefore aged out unused while the store carried on being sold as a live lead.
      //
      // Re-verified here, not trusted: the 402 can be three weeks old, and a spot-check of 10 found
      // 2 trading again. Equally the observation is not discarded just because this lane last said
      // 'active' — that verdict is the bug being fixed, and on the same 10 it was wrong 4 times out
      // of 5. So anything carrying a 402 and not already written off gets re-asked, oldest-banked
      // first, and whatever the probe says now wins.
      //
      // Capped at half the run's budget: the rate ceiling in verify-liveness.sh (~600 stores/day
      // from one residential IP) is not negotiable, and the ordinary churn sweep still has to move.
      const frozenCap = LIMIT > 0 ? Math.ceil(LIMIT / 2) : 0;
      const frozenRows = await sql`
        SELECT domain, live_miss, platform FROM imported_stores
        WHERE published AND storefront_http = 402
          AND (platform IS NULL OR lower(platform) = 'shopify')
          AND activity_tier IS DISTINCT FROM 'not_a_store'
          AND live_status IS DISTINCT FROM 'dead'
          ${COUNTRIES.length ? sql`AND UPPER(country) = ANY(${COUNTRIES})` : sql``}
        ORDER BY storefront_checked_at ASC NULLS FIRST, ${sizeOrder}
        ${frozenCap > 0 ? sql`LIMIT ${frozenCap}` : sql``}`;
      if (frozenRows.length) {
        const seen = new Set(frozenRows.map((r) => r.domain));
        rows = [...frozenRows, ...rows.filter((r) => !seen.has(r.domain))];
        if (LIMIT > 0) rows = rows.slice(0, LIMIT);
        console.log(`  …${frozenRows.length.toLocaleString()} of them a banked 402 (frozen storefront), re-checked first`);
      }
    }

    const tally = { active: 0, migrated: 0, dead: 0 };
    let done = 0, i = 0;

    let skipped = 0;
    async function persist(domain, status, res, miss, attempt = 0) {
      try {
        // A confirmed move is RECORDED, not treated as the end of the store. `platform` is healed to
        // where it now runs, migrated_from/_at keep what it left and when, and live_status goes back
        // to 'active' — because it IS active, just elsewhere. Leaving it 'migrated' is what dropped
        // the store out of the customer base (lib/browse.ts excludes the terminal states), which
        // deleted the lead at exactly the moment it became most interesting: a store that just
        // replatformed is re-choosing its payments, apps and agency.
        // Every SET below reads the OLD row — Postgres evaluates them all against the pre-UPDATE
        // tuple — so `migrated_from = platform` captures the platform being left even though the
        // same statement overwrites `platform`.
        const moved = status === "migrated";
        await sql`
          UPDATE imported_stores SET
            live_status = ${moved ? "active" : status},
            -- COALESCE keeps the FIRST move's origin: a store that moves twice should still show
            -- where it came from, and healing platform each time would otherwise rewrite history.
            migrated_from = CASE WHEN ${moved} THEN COALESCE(migrated_from, platform) ELSE migrated_from END,
            -- last_alive_at = last confirmed SELLING on the old platform, the same estimate
            -- churn_log.died_at uses. now() only when we never saw it sell.
            migrated_at = CASE WHEN ${moved} THEN COALESCE(migrated_at, last_alive_at, now()) ELSE migrated_at END,
            platform = CASE WHEN ${moved} AND ${res.platform ?? null}::text IS NOT NULL THEN ${res.platform ?? null}::text ELSE platform END,
            live_platform = ${res.platform},
            live_miss = ${miss},
            live_checked_at = now(),
            -- ...and our own clock, which only this lane writes, so the queue above can tell
            -- "nobody has HTTP-verified this store" from "a DNS lane touched it yesterday".
            verified_checked_at = now(),
            -- Stamp the first time we CONFIRM this store live (never overwrite it).
            -- This is the anchor that separates real churn from historic die-off.
            first_verified_live_at = CASE WHEN ${status} = 'active'
              THEN COALESCE(first_verified_live_at, now()) ELSE first_verified_live_at END,
            -- Stamp the LAST time we confirm it SELLING (products.json returned a catalogue) — not
            -- merely homepage-up. On any other check we leave it as-is, so it holds the last-known-
            -- selling time = our death-date estimate for the churn below (undatable when never sold).
            last_alive_at = CASE WHEN ${res.selling === true} THEN now() ELSE last_alive_at END
          WHERE domain = ${domain}`;
        // Snapshot into the churn log the moment a store is confirmed gone — including a MOVE, which
        // is still churn for the platform it left even though the store lives on. `status` here is
        // the classifier's verdict, not the live_status we just wrote (a move writes 'active').
        // The INSERT itself lives in scripts/lib/churn.mjs, shared with focus-liveness, which also
        // confirms deaths (by DNS); the domain PK means whichever lane gets there first logs it once.
        if (status === "dead" || status === "migrated") {
          await logChurn(sql, domain, status, res.platform);
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
        const { domain, live_miss, platform: knownPlatform } = rows[i++];
        const res = await classify(domain).catch(() => ({ reachable: false, shopify: false, platform: null }));
        const { status, miss } = nextStatus(null, live_miss || 0, res, knownPlatform);
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
