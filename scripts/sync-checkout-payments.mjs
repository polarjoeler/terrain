#!/usr/bin/env node
/**
 * Sync verified checkout gateways from the pipeline's checkout_cache.json into
 * the app's imported_stores.payments — so browser-verified payment providers
 * (ground truth) show up in the dashboard.
 *
 *   node --env-file=.env.local scripts/sync-checkout-payments.mjs [path/to/checkout_cache.json]
 *
 * Run it after a checkout-probe run (e.g. of the Plus queue) to close the loop.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";

const cachePath = process.argv[2] || join(homedir(), "shopify-radar", "checkout_cache.json");
const clean = (d) => (d || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");

if (!process.env.DATABASE_URL) { console.error("DATABASE_URL not set (--env-file=.env.local)"); process.exit(2); }

async function main() {
  let cache;
  try { cache = JSON.parse(readFileSync(cachePath, "utf8")); }
  catch (e) { console.error(`Could not read ${cachePath}: ${e.message}`); process.exit(1); }

  // domain -> { payments, shipping, free } (checkout-verified)
  const verified = [];
  for (const [domain, rec] of Object.entries(cache)) {
    const gw = rec?.gateways;
    const ship = rec?.shipping;
    const hasGw = Array.isArray(gw) && gw.length;
    const hasShip = Array.isArray(ship) && ship.length;
    const hasFree = typeof rec?.free_shipping === "boolean";
    if (hasGw || hasShip || hasFree) {
      verified.push([clean(domain), {
        payments: hasGw ? gw.join(";") : null,
        shipping: hasShip ? ship.join(";") : null,
        free: hasFree ? rec.free_shipping : null,
      }]);
    }
  }
  console.log(`${verified.length.toLocaleString()} domains with verified checkout data in ${cachePath.split("/").pop()}.`);

  const POOL = 8, CONCURRENCY = 6; // CONCURRENCY < POOL so queries never queue past
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: POOL });
  try {
    await sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS shipping_providers TEXT`;
    await sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS free_shipping BOOLEAN`;
    // When we last verified checkout — lets the queue re-surface stale stores for a
    // re-probe (so provider switches get caught), instead of probe-once-forever.
    await sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS payments_checked_at TIMESTAMPTZ`;
    // Event log of payment-provider shifts — the raw material for monitoring stores
    // that switch/add/drop a gateway or reorder their checkout (a live sales signal).
    // Populated here by diffing each re-probe against what we last had.
    await sql`CREATE TABLE IF NOT EXISTS payment_changes (
      id BIGSERIAL PRIMARY KEY, domain TEXT NOT NULL, changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      old_payments TEXT, new_payments TEXT, added TEXT[], removed TEXT[],
      old_primary TEXT, new_primary TEXT, reordered BOOLEAN NOT NULL DEFAULT false)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_payment_changes_at ON payment_changes (changed_at DESC)`;

    const toks = (s) => (s ? s.split(";").map((t) => t.trim()).filter(Boolean) : []);
    // Non-PSP payment METHODS/rails that render intermittently at checkout (e.g. PayFast
    // exposes "Instant EFT" / "Bank Deposit" as sub-options that come and go between
    // probes). Excluded from shift detection so a "switch" means a real gateway change.
    const PAY_NOISE = new Set(["instant eft", "bank deposit", "eft", "bank transfer",
      "cash on delivery", "cod", "manual payment", "manual", "other", "credit card",
      "debit card", "card",
      // Card networks are brands rendered at checkout, not gateways — they flap too.
      "visa", "mastercard", "amex", "american express", "discover", "maestro",
      "diners club", "diners", "unionpay", "jcb"]);

    // Bounded worker pool — NOT Promise.all over the whole batch. Firing hundreds
    // of concurrent queries at a small pool makes postgres.js deadlock the ones
    // that queue beyond `max` (the sync then hangs and the pipeline skips it).
    // A few workers, each draining the list sequentially, never exceeds the pool.
    let updated = 0, changed = 0, idx = 0;
    async function worker() {
      while (idx < verified.length) {
        const [domain, v] = verified[idx++];
        // Read what we currently have so we can detect a real shift (not first capture).
        const [cur] = await sql`SELECT payments FROM imported_stores WHERE domain = ${domain} AND published`;
        const oldP = cur?.payments ?? null;
        // A logged "shift" must be a genuine GATEWAY change, not probe noise. Two guards:
        //  1. Strip intermittent sub-rails (Instant EFT / Bank Deposit are PayFast options
        //     that flap on/off between reads) so only real gateway adds/drops count — this
        //     alone kills the {PayFast} vs {PayFast;Instant EFT;Bank Deposit} oscillation.
        //  2. De-flap: skip if this exact state was already seen for the store in the last
        //     30 days (an A→B→A revert is unstable reads, not a real switch).
        // First reads (oldP null) never log.
        if (v.payments && oldP) {
          const oTok = toks(oldP).filter((t) => !PAY_NOISE.has(t.toLowerCase()));
          const nTok = toks(v.payments).filter((t) => !PAY_NOISE.has(t.toLowerCase()));
          const added = nTok.filter((t) => !oTok.some((o) => o.toLowerCase() === t.toLowerCase()));
          const removed = oTok.filter((t) => !nTok.some((n) => n.toLowerCase() === t.toLowerCase()));
          if (added.length || removed.length) {
            const recent = await sql`SELECT 1 FROM payment_changes
              WHERE domain = ${domain} AND changed_at > now() - interval '30 days'
                AND (new_payments = ${v.payments} OR old_payments = ${v.payments}) LIMIT 1`;
            if (!recent.length) {
              await sql`INSERT INTO payment_changes
                (domain, old_payments, new_payments, added, removed, old_primary, new_primary, reordered)
                VALUES (${domain}, ${oldP}, ${v.payments}, ${added}::text[], ${removed}::text[], ${oTok[0] ?? null}, ${nTok[0] ?? null}, false)`;
              changed++;
            }
          }
        }
        // Overwrite payments with the fresh read (so a re-probe reflects the CURRENT
        // gateways); shipping/free still COALESCE (a null read shouldn't wipe them).
        const r = await sql`UPDATE imported_stores SET
              payments           = COALESCE(${v.payments}, payments),
              shipping_providers = COALESCE(${v.shipping}, shipping_providers),
              free_shipping      = COALESCE(${v.free}, free_shipping),
              payments_checked_at = CASE WHEN ${v.payments}::text IS NOT NULL THEN now() ELSE payments_checked_at END
            WHERE domain = ${domain} AND published`;
        updated += r.count;
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    console.log(`✓ Updated checkout data on ${updated.toLocaleString()} stores.`);
    if (changed) console.log(`  ↳ logged ${changed} payment-provider shift(s) to payment_changes.`);
  } finally {
    await sql.end();
  }
}

main().catch((e) => { console.error("sync failed:", e.message); process.exit(1); });
