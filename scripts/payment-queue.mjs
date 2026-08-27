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

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 6 });
  try {
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
    // Curated cohorts (Top 100, Top 1000) jump the queue — payment companies
    // care most about verified data there, so probe those first, then by value.
    // New markets (KE/NG) jump the queue ahead of the null-sales ZA long tail —
    // freshly imported, they have no sales estimate yet so would otherwise rank
    // last and never get probed. We want gateway coverage in the new markets fast.
    const queue = await sql`
      SELECT domain, estimated_monthly_sales sales, live_status,
        (domain IN (SELECT domain FROM store_tags WHERE tag = 'top-100'))  AS t100,
        (domain IN (SELECT domain FROM store_tags WHERE tag = 'top-1000')) AS t1000,
        (UPPER(country) IN ('KE', 'NG')) AS new_market
      FROM imported_stores
      WHERE published
        AND COALESCE(live_status, 'active') NOT IN ('dead', 'migrated')
        ${PLUS ? sql`AND plus = true` : sql`AND (payments IS NULL OR payments = '')`}
      ORDER BY t100 DESC, t1000 DESC, new_market DESC, estimated_monthly_sales DESC NULLS LAST
      ${LIMIT > 0 ? sql`LIMIT ${LIMIT}` : sql``}`;

    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, queue.map((r) => r.domain).join("\n") + "\n");
    const tagged = queue.filter((r) => r.t100 || r.t1000).length;

    const [cov] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE payments IS NOT NULL AND payments <> '')::int have,
        COUNT(*) FILTER (WHERE COALESCE(live_status,'active') NOT IN ('dead','migrated'))::int live
      FROM imported_stores WHERE published`;

    console.log(`\nPayment coverage: ${cov.have.toLocaleString()} have a provider · ${cov.live.toLocaleString()} live stores.`);
    console.log(`Wrote ${queue.length.toLocaleString()} unverified domains → ${OUT} (${tagged.toLocaleString()} tagged Top100/Top1000, queued first)`);
    console.log("Queue head (probe these first):");
    for (const r of queue.slice(0, 10)) {
      const tag = r.t100 ? " [Top100]" : r.t1000 ? " [Top1000]" : "";
      console.log(`   $${Number(r.sales || 0).toLocaleString().padStart(14)}/mo  ${r.domain}${tag}`);
    }
    console.log(`\nFeed to the checkout probe, e.g.:  python checkout_probe.py --from-file ${OUT} --limit 75`);
  } finally {
    await sql.end();
  }
}

main().catch((e) => { console.error("\npayment-queue failed:", e.message); process.exit(1); });
