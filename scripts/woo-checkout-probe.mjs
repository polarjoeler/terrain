#!/usr/bin/env node
/**
 * Woo checkout probe — read a WooCommerce store's ENABLED payment gateways WITHOUT touching Shopify.
 * Woo exposes the Store API on the store's own domain: GET /wp-json/wc/store/v1/cart returns a
 * `payment_methods` array of gateway IDs. An empty cart under-reports (some gateways only appear
 * when payment is due), so we add one in-stock product first (Store API nonce + cart-token), then
 * re-read. Falls back to parsing the checkout page HTML for stores with the Store API disabled.
 * Gateway IDs (bacs, cod, stripe, payfast, ppcp-gateway, woocommerce_payments, …) map to canonical
 * names and land in `payments` (payments_source='woo_checkout'). This captures the EMBEDDED core
 * methods (BACS/COD) and every plugin gateway — the full picture, unlike plugin-slug derivation.
 *
 * Each request hits the STORE's own domain (a different host per store), so there's no shared
 * Shopify-edge rate budget and no single-host throttle — safe to run from any machine.
 *
 *   node --env-file=.env.local scripts/woo-checkout-probe.mjs [--limit 300] [--concurrency 6] [--dry-run]
 *     [--recheck 1800] [--recheck-days 14] [--recheck-now]
 *
 * RE-CHECK + LIVENESS (2026-11-23). The first pass probes each store ONCE (woo_at IS NULL), so a
 * visible African Woo store was never looked at again: no liveness, no payment-provider change.
 * Now each run also
 *   · records liveness on every probe that gets an answer. A Woo answer (Store API or checkout ids)
 *     → live_status 'active'; any HTTP answer → live_miss reset to 0; live_checked_at stamped.
 *     It NEVER writes last_alive_at or verified_checked_at (verify-liveness owns both — see
 *     memory liveness-column-ownership), so churn_log.died_at stays honest.
 *   · re-probes visible-market (lib/markets.ts) Woo stores whose last probe (woo_checkout_at, this
 *     lane's OWN clock) is older than --recheck-days. A silent re-check is a MISS on the shared
 *     live_miss counter (DEAD_AFTER = 2, the same rule as verify-liveness, focus-liveness and
 *     meta-identify, so the lanes confirm each other); the second miss writes 'dead' and logs churn
 *     through scripts/lib/churn.mjs. A first miss comes back for its second look a day later.
 *     Gateways read on a re-check refresh `payments` only where this lane (or plugin derivation)
 *     owns the value — a provider from another source is never overwritten.
 *   The re-check pick is a seq scan of store_work (~6s, ~1GB read, measured 2026-11-23), so it runs
 *   in ONE fire per 6-hour UTC window (the job fires every 2h), or every run with --recheck-now.
 */
import postgres from "postgres";
import { workReady } from "./lib/work-ready.mjs";
import { logChurn } from "./lib/churn.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const LIMIT = parseInt(arg("--limit", "300"), 10);
const CONC = parseInt(arg("--concurrency", "6"), 10);
const DRY = process.argv.includes("--dry-run");
const RECHECK = parseInt(arg("--recheck", "1800"), 10);          // re-probes per re-check window
const RECHECK_DAYS = parseInt(arg("--recheck-days", "14"), 10);
const RECHECK_NOW = process.argv.includes("--recheck-now");
const RECHECK_WINDOW = RECHECK_NOW || new Date().getUTCHours() % 6 < 2;
const DEAD_AFTER = 2;                                              // = verify-liveness.mjs DEAD_AFTER
// Customer-visible markets — mirror of lib/markets.ts VISIBLE_MARKETS (as reconcile-probed.mjs does).
const VISIBLE = ["ZA","KE","NG","EG","MA","GH","TZ","UG","DZ","TN","CI","SN","MU","MZ","CM","BW","AO","NA","RW","ZM","ET","ZW","LY","MW","SO","LS","SZ"];
const UA = "terrain-radar/1.0 (woo payment probe; hello@heyterrain.com)";

// WooCommerce gateway ID / plugin token -> canonical gateway (taxonomy casing). First match wins.
const GATEWAY = [
  [/paygate|payweb|paysubs|pw3/, "PayGate"],
  [/payfast/, "PayFast"],
  [/peach/, "Peach Payments"],
  [/ozow/, "Ozow"],
  [/paystack/, "Paystack"],
  [/flutterwave/, "Flutterwave"],
  [/razorpay/, "Razorpay"],
  [/woocommerce_payments|woopayments|woocommerce-payments/, "WooPayments"],
  [/stripe/, "Stripe"],
  [/ppcp|paypal|ppec/, "PayPal"],
  [/mollie/, "Mollie"],
  [/klarna/, "Klarna"],
  [/payflex/, "Payflex"],
  [/mobicred/, "Mobicred"],
  [/float/, "Float"],
  [/payjustnow/, "PayJustNow"],
  [/happy[_-]?pay/, "Happy Pay"],
  [/snapscan/, "SnapScan"],
  [/zapper/, "Zapper"],
  [/m[_-]?pesa/, "M-Pesa"],
  [/tradesafe/, "TradeSafe"],
  [/iveri/, "iVeri"],
  [/walletdoc/, "WalletDoc"],
  [/hellopay/, "HelloPay"],
  [/layup|layby/, "Layup"],
  [/amazon[_-]?pay/, "Amazon Pay"],
  [/adyen/, "Adyen"],
  [/payulatam|\bpayu/, "PayU"],
  [/revolut/, "Revolut"],
  [/ikhokha/, "iKhokha"],
  [/stitch|wigwag/, "Stitch"],
  [/intasend/, "IntaSend"],
  [/pesapal/, "Pesapal"],
  // gateway IDs the Store API returns wrapped in underscores/class names (\b boundaries fail on
  // `class_yoco_wc_payment_gateway`), plus SA/Africa gateways seen in the field.
  [/yoco/, "Yoco"],
  [/callpay/, "CallPay"],
  [/adumo/, "Adumo Online"],
  [/njiapay/, "NjiaPay"],
  [/\bipay\b|ipayafrica|ipay_/, "iPay"],
  // embedded WooCommerce core methods (the ones with no plugin fingerprint)
  [/^bacs$|bank[_-]?transfer|direct[_-]?bank/, "Bank Transfer"],
  [/^cod$|cash[_-]?on[_-]?delivery/, "Cash on Delivery"],
  [/^cheque$|^check$/, "Cheque"],
];

const mapGateways = (ids) => {
  const out = [];
  for (const raw of ids) {
    const id = String(raw).trim().toLowerCase();
    if (!id) continue;
    const hit = GATEWAY.find(([re]) => re.test(id));
    if (hit && !out.includes(hit[1])) out.push(hit[1]);
  }
  return out;
};

const TIMEOUT = 15000;
async function get(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    return await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": UA, ...(opts.headers || {}) }, ...opts });
  } finally { clearTimeout(t); }
}

/** Store API path: read payment_methods, enriching by adding one in-stock product to a cart. */
async function storeApiProbe(base) {
  let r;
  try { r = await get(`${base}/wp-json/wc/store/v1/cart`); } catch { return { net: true, code: 0 }; }
  if (r.status === 404) return null;                    // Store API absent → try HTML
  if (!r.ok) return { net: r.status >= 500, code: r.status };
  let cart;
  try { cart = await r.json(); } catch { return null; }
  if (!cart || !Array.isArray(cart.payment_methods)) return null;
  const methods = new Set(cart.payment_methods);
  const nonce = r.headers.get("nonce") || r.headers.get("x-wc-store-api-nonce");
  const cartToken = r.headers.get("cart-token");

  // Enrich: add one purchasable simple product, then re-read (empty carts hide payment-due gateways).
  if (nonce) {
    try {
      const pr = await get(`${base}/wp-json/wc/store/v1/products?per_page=10&type=simple`);
      if (pr.ok) {
        const prods = await pr.json().catch(() => []);
        const p = (Array.isArray(prods) ? prods : []).find((x) => x?.is_purchasable && x?.is_in_stock && x?.id);
        if (p) {
          const add = await get(`${base}/wp-json/wc/store/v1/cart/add-item`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Nonce: nonce, ...(cartToken ? { "Cart-Token": cartToken } : {}) },
            body: JSON.stringify({ id: p.id, quantity: 1 }),
          });
          const tok2 = add.headers.get("cart-token") || cartToken;
          if (add.ok) {
            const c2 = await get(`${base}/wp-json/wc/store/v1/cart`, { headers: tok2 ? { "Cart-Token": tok2 } : {} });
            if (c2.ok) { const j2 = await c2.json().catch(() => null); for (const m of j2?.payment_methods || []) methods.add(m); }
          }
        }
      }
    } catch { /* enrichment best-effort; keep whatever the empty cart gave */ }
  }
  return { ids: [...methods], via: "store_api" };
}

/** Fallback: parse the checkout page HTML for gateway ids (classic `payment_method_<id>` inputs
 *  and gateway plugin asset paths). Best-effort — classic checkout may render nothing on an empty cart. */
async function htmlProbe(base) {
  for (const path of ["/checkout/", "/checkout", "/cart/"]) {
    let r;
    try { r = await get(`${base}${path}`); } catch { continue; }
    if (!r.ok) continue;
    const html = await r.text().catch(() => "");
    if (!html) continue;
    const ids = new Set();
    for (const m of html.matchAll(/payment_method_([a-z0-9_-]+)/gi)) ids.add(m[1].toLowerCase());
    for (const m of html.matchAll(/wp-content\/plugins\/([a-z0-9-]+)/gi)) ids.add(m[1].toLowerCase());
    if (ids.size) return { ids: [...ids], via: "html" };
  }
  return null;
}

async function probe(domain) {
  const base = `https://${domain}`;
  const s = await storeApiProbe(base);
  if (s?.net) return { net: true, code: s.code ?? 0 };
  let res = s && s.ids ? s : null;
  if (!res) { const h = await htmlProbe(base); if (h) res = h; }
  if (!res) return { checked: true, gateways: [] };     // reachable, nothing found → mark, don't retry
  return { checked: true, gateways: mapGateways(res.ids), via: res.via };
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: Math.min(CONC + 1, 6), idle_timeout: 20 });
  try {
    // NB: woo_checkout_at is a long-standing column (in schema.sql). Do NOT re-run
    // `ALTER TABLE … ADD COLUMN IF NOT EXISTS` here every tick — on Supabase that DDL takes a lock
    // and fires PostgREST's extensions.pgrst_ddl_watch() schema-reload trigger, which under fleet
    // load times out (seen in logs: statement-timeout 57014 inside pgrst_ddl_watch). See
    // [[postgres-schema-check-lock]]. Schema changes belong in schema.sql, not in a hot probe loop.
    // Target undated payments, then upgrade plugin-derived to checkout-verified. Skip anything already
    // checkout-probed (woo_checkout_at set); a network failure leaves it null → retried next tick.
    // ORDER BY discovered_at DESC NULLS LAST only — a boolean-expression sort key (e.g.
    // `(activity_tier IN ('selling','active')) DESC`) forces a full sort of the whole Woo candidate
    // set and statement-times-out on the throttled DB (same bug fixed in ai-enrich/deep-enrich);
    // discovered_at DESC uses idx_imported_discovered (index scan, no sort), so it stays fast.
    // store_work_woo is a partial index on exactly this selection, so the pick no longer reads the
    // whole store table (58GB/day on 2026-11-10). Falls back to the old query before the migration.
    // Africa first, as its own pass. crux-sweep.mjs (2026-11-19) banks ~1.9M WooCommerce sites from
    // every market over a few days; newest-first alone would bury the African ones it inserted first,
    // and a boolean sort key would bring back the full sort described above. The country filter
    // rides the same partial index; the global pass then fills whatever the run has left.
    const AFRICA = "DZ AO BJ BW BF BI CV CM CF TD KM CG CD CI DJ EG GQ ER SZ ET GA GM GH GN GW KE LS LR LY MG MW ML MR MU MA MZ NA NE NG RW ST SN SC SL SO ZA SS SD TZ TG TN UG ZM ZW".split(" ");
    const pickWork = async () => {
      const first = await sql`
        SELECT domain, discovered_at FROM store_work
        WHERE platform = 'woocommerce' AND live AND woo_at IS NULL AND (NOT has_pay OR pay_woo_plugin)
          AND country = ANY(${AFRICA})
        ORDER BY discovered_at DESC NULLS LAST
        LIMIT ${LIMIT}`;
      if (first.length >= LIMIT) return first;
      // Then the visible-market re-checks (stalest probe first), before any global first pass.
      const re = RECHECK_WINDOW && RECHECK > 0 ? await sql`
        SELECT domain, discovered_at, true AS recheck FROM store_work
        WHERE platform = 'woocommerce' AND published AND live AND NOT not_store
          AND country = ANY(${VISIBLE})
          AND woo_at < now() - (${RECHECK_DAYS} || ' days')::interval
        ORDER BY woo_at ASC
        LIMIT ${Math.min(RECHECK, LIMIT - first.length)}` : [];
      const room = LIMIT - first.length - re.length;
      const rest = room > 0 ? await sql`
        SELECT domain, discovered_at FROM store_work
        WHERE platform = 'woocommerce' AND live AND woo_at IS NULL AND (NOT has_pay OR pay_woo_plugin)
          AND (country IS NULL OR country <> ALL(${AFRICA}))
        ORDER BY discovered_at DESC NULLS LAST
        LIMIT ${room}` : [];
      return [...first, ...re, ...rest];
    };
    const rows = (await workReady(sql)) ? await pickWork() : await sql`
      SELECT domain, discovered_at FROM imported_stores
      WHERE lower(platform) = 'woocommerce' AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
        AND woo_checkout_at IS NULL
        AND (payments IS NULL OR payments = '' OR payments_source = 'woo_plugin')
      ORDER BY discovered_at DESC NULLS LAST
      LIMIT ${LIMIT}`;
    const nRe = rows.filter((r) => r.recheck).length;
    console.log(`woo-checkout-probe: ${rows.length} stores (${rows.length - nRe} first probes, ${nRe} visible-market re-checks${RECHECK_WINDOW ? "" : " — not this fire's window"}) (concurrency ${CONC})${DRY ? " [DRY RUN]" : ""}`);

    // Liveness written alongside every answered probe. Any HTTP answer resets the shared miss counter
    // (the store is answering — same rule as a DNS answer in focus-liveness); only a Woo answer marks
    // it 'active'. last_alive_at / verified_checked_at are deliberately absent (verify-liveness owns them).
    const liveSet = (wooAnswer) => wooAnswer
      ? sql`, live_checked_at = now(), live_miss = 0,
             live_status = CASE WHEN live_status IN ('dead','migrated') THEN live_status ELSE 'active' END`
      : sql`, live_checked_at = now(), live_miss = 0`;
    // payments is this lane's to refresh only when it (or plugin derivation) wrote it, or it is empty.
    const ownPay = () => sql`(COALESCE(payments,'') = '' OR payments_source IS NULL OR payments_source IN ('woo_checkout','woo_plugin'))`;

    let i = 0, dated = 0, none = 0, net = 0, gaveup = 0, done = 0, alive = 0, missed = 0, churned = 0, reAnswered = 0;
    const tally = new Map();
    async function worker() {
      while (i < rows.length) {
        const { domain, discovered_at, recheck } = rows[i++];
        const res = await probe(domain);
        done++;
        if (res.net && recheck && !(res.code === 0 || (res.code >= 520 && res.code <= 530))) {
          // Any other 5xx on a re-check is the host ANSWERING (a WAF challenge is often a 503, a
          // broken plugin a 500), so it is not a miss: reset the counter, try again next cycle.
          net++; reAnswered++;
          if (!DRY) await sql`UPDATE imported_stores SET woo_checkout_at = now() ${liveSet(false)}
                  WHERE domain = ${domain}`.catch(() => {});
        }
        else if (res.net && recheck) {
          // No response at all, or Cloudflare's origin-unreachable 52x: a store this lane reached
          // before has gone silent — a liveness MISS on the shared counter. Below DEAD_AFTER it keeps
          // its status and comes back a day later (woo_checkout_at is set just inside the re-check
          // gate) for the confirming look; at DEAD_AFTER it is dead + logged.
          net++;
          if (!DRY) {
            const [u] = await sql`UPDATE imported_stores SET live_miss = COALESCE(live_miss, 0) + 1,
                live_checked_at = now(),
                live_status = CASE WHEN COALESCE(live_miss, 0) + 1 >= ${DEAD_AFTER} THEN 'dead' ELSE live_status END,
                woo_checkout_at = now() - (${RECHECK_DAYS - 1} || ' days')::interval
              WHERE domain = ${domain} AND live_status IS DISTINCT FROM 'dead' AND live_status IS DISTINCT FROM 'migrated'
              RETURNING live_status`.catch(() => []);
            if (u?.live_status === "dead") { churned++; await logChurn(sql, domain, "dead").catch(() => {}); }
            else missed++;
          }
        }
        else if (res.net) {
          net++;
          // Zombie-queue guard ([[probe-queue-zombies]]): a net-fail normally leaves
          // woo_checkout_at null so it retries. But a store whose origin is permanently
          // dead (Cloudflare 52x) or that has net-failed across days of 2-hourly retries is
          // exhausted — it recycled the same ~460 rows at the head of discovered_at DESC
          // every run, so the probe never advanced. Stamp it (checked, no gateways) so it
          // drops out of the pool. A separate re-check lane can clear old stamps if a store
          // comes back. Transient failures on recently-discovered stores still retry.
          const permanent = res.code >= 520 && res.code <= 530;
          const ageMs = discovered_at ? Date.now() - new Date(discovered_at).getTime() : 0;
          // A null discovered_at is a legacy import that will never age past the threshold, so an
          // all-null-net-failing tail (seen: 6 .ng rows) recycled forever and starved the "last
          // write" health signal into a permanent alert. Treat null discovered_at as exhausted too.
          const exhausted = !discovered_at || ageMs > 3 * 24 * 3600 * 1000;   // ~36 retries at 2h cadence
          if ((permanent || exhausted) && !DRY) {
            await sql`UPDATE imported_stores SET woo_checkout_at = now(), payments_checked_at = now() WHERE domain = ${domain}`.catch(() => {});
            gaveup++;
          }
        }
        else if (res.gateways.length) {
          dated++; alive++;
          for (const g of res.gateways) tally.set(g, (tally.get(g) ?? 0) + 1);
          if (!DRY) await sql`UPDATE imported_stores SET
                    payments = CASE WHEN ${ownPay()} THEN ${res.gateways.join(";")} ELSE payments END,
                    payments_source = CASE WHEN ${ownPay()} THEN 'woo_checkout' ELSE payments_source END,
                    woo_checkout_at = now(), payments_checked_at = now() ${liveSet(true)}
                  WHERE domain = ${domain}`.catch(() => {});
        } else {
          // Reachable, no gateway read. A Woo answer (Store API / checkout ids) still proves a live Woo
          // store; a page with no Woo signal only proves something answered. Existing payments are
          // never wiped here — a re-check that reads nothing is not evidence the provider left.
          none++; if (res.via) alive++;
          if (!DRY) await sql`UPDATE imported_stores SET woo_checkout_at = now(), payments_checked_at = now() ${liveSet(!!res.via)}
                  WHERE domain = ${domain}`.catch(() => {});
        }
        if (done % 25 === 0) process.stdout.write(`\r  ${done}/${rows.length}  dated ${dated}, none ${none}, net-fail ${net}`);
      }
    }
    await Promise.all(Array.from({ length: CONC }, worker));
    console.log(`\ndone. ${dated} stores got gateways, ${none} reachable-but-none, ${net} network-failed (${gaveup} exhausted→stamped, ${net - gaveup - missed - churned - reAnswered} retry).`);
    console.log(`liveness: ${alive} confirmed live Woo · ${reAnswered} re-checks answered with a 5xx (host up, not a miss) · re-check misses ${missed} (awaiting a 2nd look) · ${churned} confirmed dead + logged`);
    console.log("by gateway:");
    for (const [g, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${g}`);
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
