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
const LIMIT = parseInt(opt("--limit", "500"), 10);
const OUT = opt("--out", "feed/payment-queue.txt");

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
    let guessed = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      await Promise.all(batch.map((r) => {
        const found = detectProviders(`${r.tech || ""} ${r.feat || ""} ${r.apps || ""}`);
        if (!found.length) return null;
        guessed++;
        return sql`UPDATE imported_stores SET payments = ${found.join(";")} WHERE domain = ${r.domain}`;
      }));
    }
    console.log(`Free parse: tagged ${guessed.toLocaleString()} stores with a payment guess.`);

    // 2. The value-ranked queue: live stores still missing a provider.
    const queue = await sql`
      SELECT domain, estimated_monthly_sales sales, live_status
      FROM imported_stores
      WHERE published
        AND COALESCE(live_status, 'active') NOT IN ('dead', 'migrated')
        AND (payments IS NULL OR payments = '')
      ORDER BY estimated_monthly_sales DESC NULLS LAST
      LIMIT ${LIMIT}`;

    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, queue.map((r) => r.domain).join("\n") + "\n");

    const [cov] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE payments IS NOT NULL AND payments <> '')::int have,
        COUNT(*) FILTER (WHERE COALESCE(live_status,'active') NOT IN ('dead','migrated'))::int live
      FROM imported_stores WHERE published`;

    console.log(`\nPayment coverage: ${cov.have.toLocaleString()} have a provider · ${cov.live.toLocaleString()} live stores.`);
    console.log(`Wrote ${queue.length.toLocaleString()} highest-value unverified domains → ${OUT}`);
    console.log("Queue head (probe these first):");
    for (const r of queue.slice(0, 10))
      console.log(`   $${Number(r.sales || 0).toLocaleString().padStart(14)}/mo  ${r.domain}`);
    console.log(`\nFeed to the checkout probe, e.g.:  python checkout_probe.py --from-file ${OUT} --limit 75`);
  } finally {
    await sql.end();
  }
}

main().catch((e) => { console.error("\npayment-queue failed:", e.message); process.exit(1); });
