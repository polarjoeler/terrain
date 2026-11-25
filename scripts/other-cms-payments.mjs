#!/usr/bin/env node
/**
 * other-cms-payments — payments + liveness for the visible stores on platforms no checkout probe
 * covers: ShopStar, OpenCart, PrestaShop, Odoo, Squarespace, Ecwid, custom builds and the rest.
 *
 * Shopify has the checkout probe, WooCommerce the Store API probe, Magento and Wix their own probes.
 * Everything else had only render-enrich --payments-gap, which reads the rendered homepage TEXT and
 * found a gateway on 4 of 400. On 2026-11-25 ZA alone held ~1,800 such leads with no payments answer.
 *
 * Per store, at most three plain GETs to the store's own domain (no Shopify edge, so no shared rate
 * budget; through the proxy fleet when STORE_PROBE_PROXY_FILE is set):
 *   1. the homepage
 *   2. the platform's cart/shop page (lib/storefront-gateways EXTRA_PATH), where "we accept" badges
 *      and payment modules load
 *   3. one product page, where BNPL widgets (Payflex, PayJustNow, Mobicred) sit beside the price
 * and reads gateways from the markup only: PSP hosts, payment-module paths, badge images
 * (lib/storefront-gateways.mjs). It never adds to a cart or types an address into a checkout: that
 * would leave a fake abandoned order in a real merchant's admin.
 *
 * What each outcome writes (payments_checked_at is stamped on every one; it is also the retry clock):
 *   gateways read       payments = the gateways, payments_source = 'storefront' (advertised on the
 *                       storefront, weaker than a checkout read; provider insights count it like
 *                       render-enrich's 'render')
 *   login-walled shop   payments_source = 'no_checkout': a B2B trade portal (Odoo /shop → /web/login).
 *                       It stays a lead (Joel 11-25: a catalogue without a store stays in) with a known
 *                       "no online checkout" answer instead of a gap
 *   readable, nothing   payments_source = 'storefront', payments empty: checked by this lane, nothing
 *   / blocked / holding advertised. Re-checked after --recheck-days
 *   gone or silent      suspended / parked / for sale, or no answer at all: a liveness MISS on the
 *                       shared live_miss counter (DEAD_AFTER = 2, the rule every liveness lane shares).
 *                       The second miss writes 'dead' and logs churn through lib/churn.mjs. A first
 *                       miss comes back after ~20h for the confirming look.
 * Any HTTP answer otherwise resets live_miss and stamps live_checked_at. It never writes last_alive_at
 * or verified_checked_at (verify-liveness owns those; memory liveness-column-ownership).
 *
 * Existing payments are never touched: the pool is rows with none. A hand-locked payments field is
 * skipped (the keep_locked_fields trigger would discard the write anyway).
 *
 *   node --env-file=.env.local scripts/other-cms-payments.mjs --dry --limit 50
 *   node --env-file=.env.local scripts/other-cms-payments.mjs [--country ZA,KE,NG] [--limit 300] [--concurrency 4]
 *   node --env-file=.env.local scripts/other-cms-payments.mjs --domains a.co.za,b.co.za --dry
 *   node --env-file=.env.local scripts/other-cms-payments.mjs --platform ecwid --recheck-days 0   # re-read one platform
 *
 * Ecwid (2026-11-26): its checkout is JS, but the storefront's public initial-data call lists the
 * merchant's enabled payment methods, so an Ecwid store gets its real checkout list from one POST
 * (payments_source 'ecwid_checkout'); a closed Ecwid store is a liveness miss; one with no method
 * switched on is 'no_checkout'.
 */
import postgres from "postgres";
import { fetchText, loadProxies, pickProxy, closeAgents } from "./lib/proxy-fetch.mjs";
import { logChurn } from "./lib/churn.mjs";
import { detectGateways, mergeFindings, pageState, platformHomeRedirect, firstProductUrl, extraPathFor, impliedGateways,
  ecwidStoreId, ecwidPayments, ecwidOwns } from "./lib/storefront-gateways.mjs";
import { cleanPayments } from "../lib/payments-taxonomy.ts";
import { VISIBLE_MARKETS } from "../lib/markets.ts";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const DRY = process.argv.includes("--dry") || process.argv.includes("--dry-run");
const VERBOSE = process.argv.includes("--verbose");
const LIMIT = Number(arg("--limit", 300));
const CONC = Number(arg("--concurrency", 4));
const RECHECK_DAYS = Number(arg("--recheck-days", 45));
const DOMAINS = (arg("--domains", "") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
// --platform ecwid: one platform only (e.g. a one-off re-read after a new method, with --recheck-days 0).
const PLATFORMS = (arg("--platform", "") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const COUNTRIES = (arg("--country", "") || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const DEAD_AFTER = 2;                                  // = verify-liveness.mjs DEAD_AFTER
// Platforms with their own payment probe. NULL platform is presumed Shopify by payment-queue.
const PROBED = ["shopify", "woocommerce", "magento", "wix"];
// Market order: the three focus markets first, then the rest of the visible set.
const FOCUS = ["ZA", "KE", "NG"];
const MARKETS = COUNTRIES.length ? COUNTRIES : [...VISIBLE_MARKETS];

const pool = loadProxies();
// 2MB: payment badges live in the FOOTER, and big theme pages run past 600KB (cashbuild 585KB,
// atmotile 590KB in the first sample) — a lower cap cuts off exactly the part we read.
const get = (url) => fetchText(url, { proxy: pickProxy(pool), timeoutMs: 15000, maxBytes: 2_000_000, redirects: 4 });

/** Ecwid's storefront settings for a store id. app.ecwid.com 301s a store hosted in another region
 *  to that region's "-internal" API host, which doesn't answer from outside; the storefront itself
 *  calls the same region's public host (eu-fra2-storefront-api.ecwid.com), so follow it there. */
async function ecwidInitialData(id, base) {
  const opts = { proxy: pickProxy(pool), timeoutMs: 15000, maxBytes: 3_000_000, method: "POST", redirects: 0,
    headers: { "Content-Type": "application/json", Referer: base + "/" }, body: { lang: "en" } };
  const post = async (url) => (await fetchText(url, opts)) ?? fetchText(url, { ...opts, proxy: pickProxy(pool) });  // one retry on another proxy
  let r = await post(`https://app.ecwid.com/storefront/api/v1/${id}/initial-data`);
  if (r && r.status >= 300 && r.status < 400 && r.location) {
    let next;
    try { next = new URL(r.location); } catch { return null; }
    if (!/\.ecwid\.com$/.test(next.hostname)) return null;
    next.hostname = next.hostname.replace(/-internal(?=\.ecwid\.com$)/, "");
    r = await post(next.href);
  }
  return r;
}

/** Homepage, with one retry on the www-toggled host (apex vs www is the commonest "unreachable"). */
async function home(domain) {
  const bare = domain.replace(/^www\./, "");
  for (const host of [domain, domain.startsWith("www.") ? bare : "www." + bare]) {
    const r = await get(`https://${host}/`);
    if (r) return { r, host };
  }
  // A plain-http site with no certificate still answers.
  const r = await get(`http://${domain}/`);
  return r ? { r, host: domain } : null;
}

export async function probe(domain, platform) {
  const h = await home(domain);
  if (!h) return { outcome: "silent" };
  const { r, host } = h;
  const base = new URL(r.url).origin;
  const st = platformHomeRedirect(domain, r.url) ? "gone" : pageState(r);
  if (st === "gone") return { outcome: "gone", status: r.status, url: r.url };
  if (st === "portal") return { outcome: "portal", url: r.url };
  if (st === "blocked" || st === "holding") return { outcome: st, status: r.status };
  if (r.status >= 400) {
    // 404/410/500 on the homepage itself: the site answers but serves no shop. Count it as nothing read.
    return { outcome: "none", status: r.status };
  }
  // Ecwid: the storefront's own public settings call lists the merchant's enabled payment methods
  // (lib/storefront-gateways ecwidPayments). One POST, no cart, no customer details. That's the
  // checkout's own list, so it is recorded as 'ecwid_checkout', stronger than an advertised badge.
  const ecId = ecwidStoreId(r.text, domain);
  if (ecId) {
    const er = await ecwidInitialData(ecId, base);
    let ej = null;
    try { ej = er && er.text ? JSON.parse(er.text) : null; } catch { /* not JSON */ }   // 409 carries the closed profile
    const ec = ecwidPayments(ej);
    if (ec.ok && ecwidOwns(ec.storeHost, domain)) {
      if (ec.closed) return { outcome: "gone", status: r.status, url: `ecwid:${ecId}:closed` };
      if (ec.gateways.length) {
        return { outcome: "found", source: "ecwid_checkout", gateways: cleanPayments(ec.gateways),
          found: ec.gateways.map((n) => ({ name: n, via: "ecwid", ev: ecId })), pages: 2 };
      }
      // An open Ecwid store with NO payment method switched on can't take an order online.
      if (!ec.methods.length) return { outcome: "portal", why: "ecwid: no payment methods", pages: 2 };
    }
  }

  const pages = [r];
  const finds = [impliedGateways(domain), detectGateways(r.text, host)];

  // The platform's cart/shop page.
  const extra = await get(base + extraPathFor(platform));
  if (extra) {
    const xs = pageState(extra);
    if (xs === "portal") return { outcome: "portal", url: extra.url };
    if (xs === "gone") return { outcome: "gone", status: extra.status, url: extra.url };
    if (extra.status < 400 && !platformHomeRedirect(domain, extra.url)) { pages.push(extra); finds.push(detectGateways(extra.text, host)); }
  }
  // One product page.
  const pu = firstProductUrl(r.text, base) || (extra && extra.status < 400 ? firstProductUrl(extra.text, base) : null);
  if (pu) {
    const p = await get(pu);
    if (p && p.status < 400 && !platformHomeRedirect(domain, p.url)) { pages.push(p); finds.push(detectGateways(p.text, host)); }
  }
  const found = mergeFindings(...finds);
  const names = cleanPayments(found.map((f) => f.name));
  return { outcome: names.length ? "found" : "none", gateways: names, found, pages: pages.length };
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL not set (--env-file=.env.local)"); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3, idle_timeout: 20,
    connection: { statement_timeout: 90000, lock_timeout: 4000, idle_in_transaction_session_timeout: 60000 } });
  try {
    // The pool: visible leads on an unprobed platform with no payments answer. "No answer" is empty
    // payments AND no verdict from this lane yet (payments_source NULL, e.g. render-enrich stamped it
    // checked but found nothing), or this lane's own 'storefront'-nothing verdict gone stale. A row
    // stamped in the last ~20h (a first liveness miss waiting for its second look) waits.
    const rows = DOMAINS.length
      ? await sql`SELECT domain, platform, country FROM imported_stores WHERE domain = ANY(${DOMAINS})`
      : await sql`
          SELECT domain, platform, country FROM imported_stores
          WHERE published AND country = ANY(${MARKETS})
            AND platform IS NOT NULL AND lower(platform) <> ALL(${PROBED})
            ${PLATFORMS.length ? sql`AND lower(platform) = ANY(${PLATFORMS})` : sql``}
            AND activity_tier IS DISTINCT FROM 'not_a_store'
            AND (live_status IS NULL OR live_status NOT IN ('dead', 'migrated'))
            AND COALESCE(payments, '') = ''
            AND NOT ('payments' = ANY(COALESCE(locked_fields, '{}'::text[])))
            AND position('/' in domain) = 0
            AND (
              (payments_source IS NULL AND (payments_checked_at IS NULL OR payments_checked_at < now() - interval '20 hours'))
              OR (payments_source = 'storefront' AND payments_checked_at < now() - (${RECHECK_DAYS} || ' days')::interval)
            )
          ORDER BY array_position(${FOCUS}::text[], country) NULLS LAST,
                   revenue_ballpark_usd DESC NULLS LAST, crux_rank ASC NULLS LAST
          LIMIT ${LIMIT}`;
    console.log(`other-cms-payments: ${rows.length} store(s) · concurrency ${CONC} · ${pool.length ? `${pool.length} proxies` : "DIRECT"}${DRY ? " · DRY" : ""}`);
    if (!rows.length) return;

    const n = { found: 0, none: 0, portal: 0, blocked: 0, holding: 0, gone: 0, silent: 0, missed: 0, dead: 0, failed: 0 };
    const byGw = new Map(), byVia = new Map(), byPlat = new Map();
    const answered = sql`, live_checked_at = now(), live_miss = 0`;
    const write = async (q, domain) => { if (DRY) return; try { await q; } catch (e) { n.failed++; console.log(`  write failed ${domain}: ${e.message}`); } };

    let i = 0;
    async function worker() {
      while (i < rows.length) {
        const { domain, platform, country } = rows[i++];
        let res;
        try { res = await probe(domain, platform); } catch (e) { res = { outcome: "silent", err: e.message }; }
        n[res.outcome]++;
        const pk = `${platform}:${res.outcome}`; byPlat.set(pk, (byPlat.get(pk) || 0) + 1);
        if (res.outcome === "found") {
          for (const g of res.gateways) byGw.set(g, (byGw.get(g) || 0) + 1);
          for (const f of res.found) byVia.set(f.via, (byVia.get(f.via) || 0) + 1);
          await write(sql`UPDATE imported_stores SET payments = ${res.gateways.join("; ")}, payments_source = ${res.source || "storefront"},
                payments_checked_at = now() ${answered}
              WHERE domain = ${domain} AND COALESCE(payments, '') = ''`, domain);
        } else if (res.outcome === "portal") {
          await write(sql`UPDATE imported_stores SET payments_source = 'no_checkout', payments_checked_at = now() ${answered}
              WHERE domain = ${domain} AND COALESCE(payments, '') = ''`, domain);
        } else if (res.outcome === "none" || res.outcome === "blocked" || res.outcome === "holding") {
          await write(sql`UPDATE imported_stores SET payments_source = 'storefront', payments_checked_at = now() ${answered}
              WHERE domain = ${domain} AND COALESCE(payments, '') = ''`, domain);
        } else {
          // gone / silent: a liveness miss. The second one is a death, logged as churn.
          if (!DRY) {
            try {
              const [u] = await sql`UPDATE imported_stores SET live_miss = COALESCE(live_miss, 0) + 1, live_checked_at = now(),
                    live_status = CASE WHEN COALESCE(live_miss, 0) + 1 >= ${DEAD_AFTER} THEN 'dead' ELSE live_status END,
                    payments_checked_at = now()
                  WHERE domain = ${domain} AND live_status IS DISTINCT FROM 'dead' AND live_status IS DISTINCT FROM 'migrated'
                  RETURNING live_status`;
              if (u?.live_status === "dead") { n.dead++; await logChurn(sql, domain, "dead").catch(() => {}); } else n.missed++;
            } catch (e) { n.failed++; console.log(`  write failed ${domain}: ${e.message}`); }
          }
        }
        if (VERBOSE || DRY) {
          const ev = res.found?.map((f) => `${f.name}<${f.via}:${f.ev}>`).join(" ") || "";
          console.log(`  ${res.outcome.padEnd(8)} ${String(country).padEnd(3)} ${String(platform).slice(0, 12).padEnd(12)} ${domain.padEnd(36)} ${res.status ? `[${res.status}] ` : ""}${ev}`);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, rows.length) }, worker));
    const tot = rows.length;
    console.log(`\ndone. ${tot} stores · gateways read ${n.found} (${Math.round((100 * n.found) / tot)}%) · B2B portal ${n.portal} · nothing advertised ${n.none} · blocked ${n.blocked} · holding ${n.holding} · gone ${n.gone} · silent ${n.silent}`);
    if (!DRY) console.log(`liveness: ${n.missed} first misses (back for a second look in ~20h) · ${n.dead} confirmed dead + logged · ${n.failed} write failures`);
    if (byGw.size) console.log("by gateway: " + [...byGw].sort((a, b) => b[1] - a[1]).map(([g, c]) => `${g} ${c}`).join(" · "));
    if (byVia.size) console.log("evidence: " + [...byVia].map(([v, c]) => `${v} ${c}`).join(" · "));
    console.log("by platform: " + [...byPlat].sort((a, b) => a[0].localeCompare(b[0])).map(([k, c]) => `${k}=${c}`).join(" "));
  } finally {
    closeAgents();
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
