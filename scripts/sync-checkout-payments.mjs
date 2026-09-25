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

import { readFileSync, writeFileSync } from "node:fs";
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

  // Incremental: only sync entries probed since the last successful sync. The old code re-processed
  // the ENTIRE (growing) cache every hourly run; once it crept past ~8k rows it began exceeding the
  // pipeline's time budget → "sync failed" → payments_checked_at never advanced → the queue re-probed
  // the same stores forever. Keyed on probed_at, with a small overlap so nothing slips the boundary.
  const statePath = join(homedir(), "shopify-radar", ".sync_state.json");
  let lastSync = 0;
  try { lastSync = Date.parse(JSON.parse(readFileSync(statePath, "utf8")).last_synced_at) || 0; } catch {}
  const cutoff = lastSync ? lastSync - 20 * 60e3 : Date.now() - 6 * 3600e3; // first run: last 6h
  const fresh = (rec) => { const t = rec?.probed_at ? Date.parse(rec.probed_at) : NaN; return isNaN(t) || t >= cutoff; };

  // domain -> { payments, shipping, free } (checkout-verified)
  const verified = [];
  for (const [domain, rec] of Object.entries(cache)) {
    if (!fresh(rec)) continue;
    const gw = rec?.gateways;
    const ship = rec?.shipping;
    const hasGw = Array.isArray(gw) && gw.length;
    const hasShip = Array.isArray(ship) && ship.length;
    const hasFree = typeof rec?.free_shipping === "boolean";
    const hasPlus = rec?.plus === "strong"; // independent, still-Plus-exclusive fingerprint
    if (hasGw || hasShip || hasFree || hasPlus) {
      verified.push([clean(domain), {
        payments: hasGw ? gw.join(";") : null,
        shipping: hasShip ? ship.join(";") : null,
        free: hasFree ? rec.free_shipping : null,
        plus: hasPlus,
      }]);
    }
  }
  // Stores we REACHED at checkout that rendered NO gateway — i.e. "checked, hasn't chosen a
  // payment provider yet" (a real prospect signal), as opposed to stores we never probed or
  // couldn't test. ONLY the genuine no-gateway note counts: `no_variant` means we couldn't
  // even reach a testable checkout, and errors/WAF blocks aren't a signal — those stay
  // "unknown", never "no gateway".
  const checkedEmpty = Object.entries(cache)
    .filter(([, rec]) => fresh(rec) && String(rec?.note || "").startsWith("no_gateways_found"))
    .map(([d]) => clean(d));
  console.log(`${verified.length.toLocaleString()} domains with verified checkout data · ${checkedEmpty.length.toLocaleString()} confirmed no-gateway (probed, none chosen).`);

  const POOL = 8, CONCURRENCY = 6; // CONCURRENCY < POOL so queries never queue past
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: POOL });
  // Idempotent schema setup. IF NOT EXISTS isn't atomic, so two overlapping syncs can still race
  // (42P07 "already exists") — swallow that so an overlap never aborts the run.
  const ddl = async (q) => { try { await q; } catch (e) { if (!/already exists/i.test(e?.message || "")) throw e; } };
  try {
    await ddl(sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS shipping_providers TEXT`);
    await ddl(sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS free_shipping BOOLEAN`);
    // When we last verified checkout — lets the queue re-surface stale stores for a
    // re-probe (so provider switches get caught), instead of probe-once-forever.
    await ddl(sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS payments_checked_at TIMESTAMPTZ`);
    await ddl(sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS plus_signal TEXT`);
    // Event log of payment-provider shifts — the raw material for monitoring stores
    // that switch/add/drop a gateway or reorder their checkout (a live sales signal).
    // Populated here by diffing each re-probe against what we last had.
    await ddl(sql`CREATE TABLE IF NOT EXISTS payment_changes (
      id BIGSERIAL PRIMARY KEY, domain TEXT NOT NULL, changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      old_payments TEXT, new_payments TEXT, added TEXT[], removed TEXT[],
      old_primary TEXT, new_primary TEXT, reordered BOOLEAN NOT NULL DEFAULT false)`);
    await ddl(sql`CREATE INDEX IF NOT EXISTS idx_payment_changes_at ON payment_changes (changed_at DESC)`);

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

    // Collapse a sub-brand RAIL to its parent gateway for change DETECTION only (the display
    // token is still stored verbatim). A merchant relabelling between "Paystack" and "Paystack
    // Onsite" — or "Stitch" and "WigWag" — is the SAME gateway; logging it as a switch was the
    // Sep-2026 Paystack-Onsite flap that spammed the change log with bogus removes/adds. Mirrors
    // the sub-brand groups in lib/payments-taxonomy.ts (PROVIDER_SUBBRANDS) — keep in sync if
    // more are added there. Everything else canonicalises to its own lowercase form.
    const canonGateway = (t) => {
      const s = t.toLowerCase();
      if (s.includes("paystack")) return "paystack";
      if (s.includes("wigwag") || /\bstitch\b/.test(s)) return "stitch";
      return s;
    };

    // Bounded worker pool — NOT Promise.all over the whole batch. Firing hundreds
    // of concurrent queries at a small pool makes postgres.js deadlock the ones
    // that queue beyond `max` (the sync then hangs and the pipeline skips it).
    // A few workers, each draining the list sequentially, never exceeds the pool.
    let updated = 0, changed = 0, idx = 0;
    async function worker() {
      while (idx < verified.length) {
        const [domain, v] = verified[idx++];
        // Read what we currently have so we can detect a real shift (not first capture).
        const [cur] = await sql`SELECT payments, payments_source FROM imported_stores WHERE domain = ${domain} AND published`;
        const oldP = cur?.payments ?? null;
        // A bootstrap import (e.g. StoreCensus generic gateways) is NOT a prior probe, so the
        // first checkout probe over it is an INITIAL capture, not a switch — comparing our
        // verified read against a bootstrap value would log a bogus switch. Only probe-verified
        // baselines (source NULL / woo_*) count for switch detection.
        const bootstrap = cur?.payments_source === "storecensus";
        // A logged "shift" must be a genuine GATEWAY change, not probe noise. Two guards:
        //  1. Strip intermittent sub-rails (Instant EFT / Bank Deposit are PayFast options
        //     that flap on/off between reads) so only real gateway adds/drops count — this
        //     alone kills the {PayFast} vs {PayFast;Instant EFT;Bank Deposit} oscillation.
        //  2. De-flap: skip if this exact state was already seen for the store in the last
        //     30 days (an A→B→A revert is unstable reads, not a real switch).
        // First reads (oldP null) and first probes over a bootstrap import never log.
        if (v.payments && oldP && !bootstrap) {
          const oTok = toks(oldP).filter((t) => !PAY_NOISE.has(t.toLowerCase()));
          const nTok = toks(v.payments).filter((t) => !PAY_NOISE.has(t.toLowerCase()));
          // Diff on CANONICAL gateway so a sub-brand relabel (Paystack ⇄ Paystack Onsite) is not
          // a change: a token is "added" only if its parent gateway wasn't already present, and
          // "removed" only if its parent gateway is now gone entirely.
          const oCanon = new Set(oTok.map(canonGateway));
          const nCanon = new Set(nTok.map(canonGateway));
          const added = nTok.filter((t) => !oCanon.has(canonGateway(t)));
          const removed = oTok.filter((t) => !nCanon.has(canonGateway(t)));
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
              payments_checked_at = CASE WHEN ${v.payments}::text IS NOT NULL THEN now() ELSE payments_checked_at END,
              -- once our probe verifies gateways, clear the bootstrap marker so future probes
              -- compare probe-to-probe (matching the NULL convention of probe-verified Shopify).
              payments_source = CASE WHEN ${v.payments}::text IS NOT NULL AND payments_source = 'storecensus' THEN NULL ELSE payments_source END,
              -- an independent, still-Plus-exclusive fingerprint (multipass / Plus badge) confirms
              -- Plus on its own — record it and set the confident flag live (never un-set).
              plus_signal = CASE WHEN ${v.plus} THEN 'strong' ELSE plus_signal END,
              plus        = CASE WHEN ${v.plus} THEN true ELSE plus END
            WHERE domain = ${domain} AND published`;
        updated += r.count;
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    console.log(`✓ Updated checkout data on ${updated.toLocaleString()} stores.`);

    // Stamp "we checked, no gateway" — records payments_checked_at while leaving payments
    // empty, so the DB distinguishes checked-empty (a prospect) from never-probed (unknown).
    // Guarded so it never overwrites a store that DOES have a gateway on record.
    if (checkedEmpty.length) {
      const r = await sql`UPDATE imported_stores SET payments_checked_at = now()
        WHERE domain = ANY(${checkedEmpty}) AND published AND (payments IS NULL OR payments = '')`;
      console.log(`  ↳ marked ${r.count.toLocaleString()} stores checked-but-no-gateway (probed, no provider yet).`);
    }
    if (changed) console.log(`  ↳ logged ${changed} payment-provider shift(s) to payment_changes.`);
    // Advance the incremental watermark only after a successful pass.
    writeFileSync(statePath, JSON.stringify({ last_synced_at: new Date().toISOString() }));
  } finally {
    await sql.end();
  }
}

main().catch((e) => { console.error("sync failed:", e.message); process.exit(1); });
