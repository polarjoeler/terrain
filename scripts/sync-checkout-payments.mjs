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

  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 4 });
  try {
    await sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS shipping_providers TEXT`;
    await sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS free_shipping BOOLEAN`;
    let updated = 0;
    for (let i = 0; i < verified.length; i += 200) {
      const batch = verified.slice(i, i + 200);
      const res = await Promise.all(batch.map(([domain, v]) =>
        sql`UPDATE imported_stores SET
              payments           = COALESCE(${v.payments}, payments),
              shipping_providers = COALESCE(${v.shipping}, shipping_providers),
              free_shipping      = COALESCE(${v.free}, free_shipping)
            WHERE domain = ${domain} AND published`,
      ));
      updated += res.reduce((n, r) => n + r.count, 0);
    }
    console.log(`✓ Updated checkout data (payments/shipping/free) on ${updated.toLocaleString()} imported stores.`);
  } finally {
    await sql.end();
  }
}

main().catch((e) => { console.error("sync failed:", e.message); process.exit(1); });
