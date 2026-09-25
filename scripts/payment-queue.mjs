#!/usr/bin/env node
/**
 * Q3 — prioritise payment-provider scanning by value.
 *
 *   node --env-file=.env.local scripts/payment-queue.mjs [--limit 500] [--out feed/payment-queue.txt]
 *
 * Two things:
 *  1. FREE first pass — parse the imported data's technologies/features/apps for
 *     named payment providers and record them (no fetching). Sparse (~1%) but free.
 *  2. The QUEUE — emit the highest-value live stores that still lack a payment
 *     provider, ordered by estimated_monthly_sales, for the (expensive, browser-
 *     based) checkout probe to verify top-down. Writes a domain list to --out.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import postgres from "postgres";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PLUS = args.includes("--plus"); // enrich ALL Shopify Plus stores (highest value)
const LIMIT = parseInt(opt("--limit", PLUS ? "0" : "500"), 10); // 0 = no cap
const OUT = opt("--out", PLUS ? "feed/payment-queue-plus.txt" : "feed/payment-queue.txt");
// --country ZA,KE,NG,JP scopes probing to target markets so global discoveries (ct-tail is
// TLD-agnostic and lands the whole CT firehose) don't consume checkout probes — each probe
// leaves an abandoned checkout in the merchant's admin, so probing off-target stores is waste.
let CLIST = (opt("--country", null) || "").toUpperCase().split(",").map((s) => s.trim()).filter(Boolean);
// --providers "paystack,stitch,peach" — a WATCH run: re-probe the stores that CURRENTLY carry
// one of these providers (ignoring the normal staleness gate) so we catch switches away / gateway
// churn for named providers on a schedule (weekly Sunday → Monday inbox). Bounded cohort, so it
// re-probes ALL of them rather than reserving a thin slice. ADDS-to-provider still come from the
// normal probe; a watch only ever sees the current carriers change.
const PROVIDERS = (opt("--providers", null) || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set (run with --env-file=.env.local)");
  process.exit(2);
}

// Unambiguous SA / global payment-provider tokens (avoid bare "float"/"stripe"
// noise by requiring distinctive strings).
const PSP = {
  PayFast: ["payfast"], "Peach Payments": ["peach payment", "peachpayment"],
  Yoco: ["yoco"], Ozow: ["ozow"], PayGate: ["paygate"], Paystack: ["paystack"],
  PayPal: ["paypal"], Payflex: ["payflex"], PayJustNow: ["payjustnow"],
  Mobicred: ["mobicred"], SnapScan: ["snapscan"], Zapper: ["zapper"],
  "Stripe": ["stripe payment", "stripe.com"],
};

function detectProviders(blob) {
  const hay = (blob || "").toLowerCase();
  const found = [];
  for (const [name, toks] of Object.entries(PSP))
    if (toks.some((t) => hay.includes(t))) found.push(name);
  return found;
}

// Provider token → the LIKE fragments that identify it in our normalised `payments` column.
const WATCH_TOKENS = {
  paystack: ["paystack"],
  stitch: ["stitch"],
  peach: ["peach payment", "peachpayment", "peach"],
};

async function watchRun(sql) {
  // Build the ILIKE predicate for the requested providers over the current `payments` value.
  const frags = PROVIDERS.flatMap((p) => WATCH_TOKENS[p] || [p]);
  const rows = await sql`
    SELECT domain, estimated_monthly_sales sales, payments,
      (domain IN (SELECT domain FROM store_tags WHERE tag = 'top-100'))  AS t100,
      (domain IN (SELECT domain FROM store_tags WHERE tag = 'top-500')) AS t500
    FROM imported_stores
    WHERE published
      AND COALESCE(live_status, 'active') NOT IN ('dead', 'migrated')
      AND (lower(platform) = 'shopify' OR platform IS NULL)  -- Shopify checkout probe only (Woo has its own)
      AND payments IS NOT NULL AND payments <> ''
      ${CLIST.length ? sql`AND UPPER(country) = ANY(${CLIST})` : sql``}
      AND (${frags.map((f) => sql`lower(payments) LIKE ${"%" + f + "%"}`).reduce((a, b) => sql`${a} OR ${b}`)})
    ORDER BY estimated_monthly_sales DESC NULLS LAST`;
  const cap = LIMIT > 0 ? LIMIT : rows.length;
  const queue = rows.slice(0, cap);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, queue.map((r) => r.domain).join("\n") + "\n");
  const tagged = queue.filter((r) => r.t100 || r.t500).length;
  console.log(`Provider WATCH [${PROVIDERS.join(", ")}]${CLIST.length ? ` in ${CLIST.join(",")}` : ""}: ${rows.length.toLocaleString()} current carriers.`);
  console.log(`Wrote ${queue.length.toLocaleString()} domains → ${OUT} (${tagged.toLocaleString()} Top100/500). Re-probing ALL to catch switches away / gateway churn.`);
  for (const r of queue.slice(0, 10)) console.log(`   $${Number(r.sales || 0).toLocaleString().padStart(14)}/mo  ${r.domain}`);
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 6 });

  // Honour the ops priority cue: a "country completeness" priority makes that country LEAD the
  // queue (drains toward 100% first) WITHOUT excluding the other focus markets — it takes up to
  // ~75% of each run's initial-probe slots and the rest (KE/NG/JP/Africa) keep the remainder, so
  // they still make progress. The provider-WATCH run (--providers) is exempt: switch detection
  // must stay all-markets even during a country drain.
  let priorityCC = null;
  if (!PROVIDERS.length) {
    try {
      const [pr] = await sql`SELECT value FROM app_settings WHERE key = 'ops.priority'`;
      const p = pr ? JSON.parse(pr.value) : null;
      if (p && p.mode === "country" && p.country) {
        priorityCC = String(p.country).toUpperCase();
        console.log(`priority cue: country-completeness ${priorityCC} → ${priorityCC} leads the queue (~75%); other focus markets keep the rest`);
      }
    } catch { /* app_settings missing / bad json → ignore */ }
  }
  try {
    if (PROVIDERS.length) { await watchRun(sql); return; }
    // 1. Free parse over the imported data.
    const rows = await sql`
      SELECT domain, raw->>'technologies' tech, raw->>'features' feat, apps
      FROM imported_stores WHERE published AND payments IS NULL`;
    // Compute guesses (CPU only), then apply UPDATEs with a BOUNDED worker pool.
    // NOT Promise.all over 500 rows: that queues ~494 queries past the max:6 pool
    // and postgres.js deadlocks the queued ones — the script hangs, the pipeline
    // swallows it (|| continuing), and the probe queue never regenerates.
    const updates = [];
    for (const r of rows) {
      const found = detectProviders(`${r.tech || ""} ${r.feat || ""} ${r.apps || ""}`);
      if (found.length) updates.push([r.domain, found.join(";")]);
    }
    let guessed = 0, gi = 0;
    async function guessWorker() {
      while (gi < updates.length) {
        const [domain, payments] = updates[gi++];
        await sql`UPDATE imported_stores SET payments = ${payments} WHERE domain = ${domain}`;
        guessed++;
      }
    }
    await Promise.all(Array.from({ length: 4 }, guessWorker)); // 4 workers < max:6
    console.log(`Free parse: tagged ${guessed.toLocaleString()} stores with a payment guess.`);

    // 2. The value-ranked queue. --plus = every live Shopify Plus store (probe
    //    all of them, since Plus are the highest-value merchants); otherwise the
    //    highest-value live stores that still lack a provider.
    // Curated cohorts (Top 100, Top 500) jump the queue — payment companies
    // care most about verified data there, so probe those first, then by value.
    // New markets (KE/NG) jump the queue ahead of the null-sales ZA long tail —
    // freshly imported, they have no sales estimate yet so would otherwise rank
    // last and never get probed. We want gateway coverage in the new markets fast.
    // Eligibility with a TIER-AWARE re-probe cadence (#1): high-value stores
    // (Top 100/500/Plus) are re-checked every 10 days so provider SWITCHES there —
    // the ones payment companies care about — are caught fast; the long tail every
    // 75 days. Unprobed stores are always eligible.
    const HV_REPROBE_DAYS = 7, TAIL_REPROBE_DAYS = 21;
    const eligible = await sql`
      SELECT domain, estimated_monthly_sales sales, live_status, discovered_at, source, country,
        (payments IS NULL OR payments = '') AS needs_initial,
        COALESCE(plus, false) AS plus,
        (domain IN (SELECT domain FROM store_tags WHERE tag = 'top-100'))  AS t100,
        (domain IN (SELECT domain FROM store_tags WHERE tag = 'top-500')) AS t500,
        (UPPER(country) IN ('KE', 'NG')) AS new_market
      FROM imported_stores
      WHERE published
        AND COALESCE(live_status, 'active') NOT IN ('dead', 'migrated')
        -- checkout_probe.py is SHOPIFY-specific (products.json + Shopify checkout). Feeding it
        -- WooCommerce/other-platform stores just burns budget on guaranteed no_variant results —
        -- those are the Woo probe's job. Keep NULL (unclassified, most likely Shopify).
        AND (lower(platform) = 'shopify' OR platform IS NULL)
        ${CLIST.length ? sql`AND UPPER(country) = ANY(${CLIST})` : sql``}
        ${PLUS ? sql`AND plus = true`
               : sql`AND (
                   payments IS NULL OR payments = ''
                   OR ( (plus = true OR domain IN (SELECT domain FROM store_tags WHERE tag IN ('top-100','top-500')))
                        AND payments_checked_at < now() - (${HV_REPROBE_DAYS}::int * interval '1 day') )
                   OR payments_checked_at < now() - (${TAIL_REPROBE_DAYS}::int * interval '1 day')
                 )`}
      ORDER BY estimated_monthly_sales DESC NULLS LAST`;

    // DRAIN MODE: coverage is diluting (new stores land faster than we probe them), so spend
    // the run mostly on INITIAL probes — never-probed stores, highest-value first — and reserve
    // only a thin slice for re-probes (switch detection on high-value stores). Once the
    // never-probed backlog is gone, `init` runs short and the re-probe cadence naturally
    // reclaims the freed slots. Tune with --reprobe-share / REPROBE_SHARE (0 = pure drain).
    const isHV = (r) => r.t100 || r.t500 || r.plus;
    const cap = LIMIT > 0 ? LIMIT : eligible.length;
    // Boosted from 0.12 → 0.30 to clear the African StoreCensus re-probe backlog fast (their
    // StoreCensus payment data was unreliable — see clean-storecensus-payments). The re-probe
    // ordering below sends that slice to the African cohort first. Revert to 0.12 once drained.
    const REPROBE_SHARE = Math.min(1, Math.max(0,
      parseFloat(opt("--reprobe-share", process.env.REPROBE_SHARE || "0.30"))));
    // NEW STORES FIRST. The product sells subscribers fast access to new leads, so a
    // freshly-discovered store must get its gateway probed before the value backlog — a
    // brand-new lead with no payment data is worthless the week it matters most. Order
    // initial probes newest-discovered first; HV / new-market only break ties on the same day.
    const disc = (r) => (r.discovered_at ? new Date(r.discovered_at).getTime() : 0);
    // African StoreCensus cohort first: their imported payment data was US-centric/unreliable (see
    // clean-storecensus-payments), so establishing our own probe-verified gateways for them is the
    // priority. Scoped to non-Shopify-Payments markets — JP/US/EU StoreCensus data is valid there,
    // so it isn't boosted. Self-limiting: once the African backlog drains, sc()=0 for all and it
    // falls back to the normal newest-first-then-value ordering.
    const SP = new Set(["US","CA","GB","AU","NZ","IE","JP","SG","HK","AT","BE","CZ","DK","FI","FR","DE","IT","NL","PT","ES","SE","CH","RO","BG","HR","CY","EE","GR","HU","LV","LT","LU","MT","PL","SK","SI"]);
    const sc = (r) => (r.source === "storecensus" && !SP.has((r.country || "").toUpperCase()) ? 1 : 0);
    const init = eligible.filter((r) => r.needs_initial).sort((a, b) => {
      const s = sc(b) - sc(a); if (s) return s;                       // StoreCensus reset cohort first
      if (sc(a)) return (b.sales || 0) - (a.sales || 0);              // within it: highest-value first
      return disc(b) - disc(a)                                        // fresh CT discoveries: newest first (unchanged)
        || (isHV(b) ? 1 : 0) - (isHV(a) ? 1 : 0)
        || (b.new_market ? 1 : 0) - (a.new_market ? 1 : 0);
    });
    const reprobes = eligible.filter((r) => !r.needs_initial).sort((a, b) =>
      sc(b) - sc(a)                                                   // African StoreCensus re-verify first
      || (isHV(b) ? 1 : 0) - (isHV(a) ? 1 : 0)                        // then HV switch detection
      || (b.sales || 0) - (a.sales || 0));                           // then by value
    const reSlots = Math.min(reprobes.length, Math.round(cap * REPROBE_SHARE));
    const initSlots = Math.max(0, cap - reSlots);
    // ZA-priority-but-not-exclusive: the cued country leads with up to ~75% of the initial slots;
    // the other focus markets take the rest so they keep progressing (and get MORE when ZA runs short).
    let takeInit;
    if (priorityCC) {
      const isPri = (r) => (r.country || "").toUpperCase() === priorityCC;
      const pri = init.filter(isPri).slice(0, Math.round(initSlots * 0.75));
      const rest = init.filter((r) => !isPri(r)).slice(0, initSlots - pri.length);
      takeInit = [...pri, ...rest];
    } else {
      takeInit = init.slice(0, initSlots);
    }
    const takeRe = reprobes.slice(0, cap - takeInit.length);
    const queue = [...takeInit, ...takeRe]; // never-probed (HV→new-market→value) first, re-probes last
    const reprobeCount = takeRe.length;

    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, queue.map((r) => r.domain).join("\n") + "\n");
    const tagged = queue.filter((r) => r.t100 || r.t500).length;

    const [cov] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE payments IS NOT NULL AND payments <> '')::int have,
        COUNT(*) FILTER (WHERE COALESCE(live_status,'active') NOT IN ('dead','migrated'))::int live
      FROM imported_stores WHERE published`;

    console.log(`\nPayment coverage: ${cov.have.toLocaleString()} have a provider · ${cov.live.toLocaleString()} live stores.`);
    console.log(`Wrote ${queue.length.toLocaleString()} domains → ${OUT} (${tagged.toLocaleString()} Top100/500 first · ${reprobeCount.toLocaleString()} re-probes reserved for switch detection · ${(queue.length - reprobeCount).toLocaleString()} initial)`);
    console.log("Queue head (probe these first):");
    for (const r of queue.slice(0, 10)) {
      const tag = r.t100 ? " [Top100]" : r.t500 ? " [Top500]" : "";
      console.log(`   $${Number(r.sales || 0).toLocaleString().padStart(14)}/mo  ${r.domain}${tag}`);
    }
    console.log(`\nFeed to the checkout probe, e.g.:  python checkout_probe.py --from-file ${OUT} --limit 75`);
  } finally {
    await sql.end();
  }
}

main().catch((e) => { console.error("\npayment-queue failed:", e.message); process.exit(1); });
