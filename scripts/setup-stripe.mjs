#!/usr/bin/env node
/** Create the Terrain products + prices in Stripe, from lib/plans.ts.
 *
 *     node --env-file=.env.local scripts/setup-stripe.mjs            # dry run (default)
 *     node --env-file=.env.local scripts/setup-stripe.mjs --commit   # actually create
 *
 *  The amounts are NOT written here — they are imported from lib/plans.ts, which is the
 *  single source of truth the app reads for entitlements. A price that disagrees with the
 *  app is the one bug this script exists to make impossible, so it cannot be introduced
 *  by editing the script.
 *
 *  Idempotent via Stripe `lookup_key`, not name/amount matching: a lookup key is unique
 *  per account, so re-running finds the exact price rather than guessing. Stripe prices
 *  are IMMUTABLE — an amount can never be edited. So if a price exists under a lookup key
 *  at a DIFFERENT amount, this script refuses to touch it and tells you; moving the key to
 *  a new price is a deliberate act (--replace), because it changes what new subscribers pay
 *  while existing subscriptions stay on the old price.
 *
 *  Prints the env block for .env.local AND Vercel. Nothing is written to either.
 */
import Stripe from "stripe";
import { PLANS, PLAN_ORDER, ADDON_RADAR_PARTNERS_USD, EXTRA_SEAT_USD } from "../lib/plans.ts";

const COMMIT = process.argv.includes("--commit");
const REPLACE = process.argv.includes("--replace");

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY) {
  console.error("Set STRIPE_SECRET_KEY first (pass --env-file=.env.local).");
  process.exit(1);
}
const LIVE = KEY.startsWith("sk_live");
const stripe = new Stripe(KEY);

// Every plan charges the same for a seat, so one seat price serves all three. Assert it,
// rather than trusting the constant to have kept up with the table.
for (const k of PLAN_ORDER) {
  if (PLANS[k].extraSeatUsd !== EXTRA_SEAT_USD) {
    console.error(`plans.ts disagrees with itself: ${k}.extraSeatUsd=${PLANS[k].extraSeatUsd}, EXTRA_SEAT_USD=${EXTRA_SEAT_USD}`);
    process.exit(1);
  }
}

/** One spec per Stripe price we need. Amounts come from PLANS; nothing is hardcoded. */
const SPECS = [];
for (const key of PLAN_ORDER) {
  const plan = PLANS[key];
  const platforms = plan.platforms.join(" + ");
  const limit = plan.exportLimit == null ? "unlimited leads" : `${plan.exportLimit.toLocaleString()} leads/mo`;
  SPECS.push({
    env: `STRIPE_PRICE_${key.toUpperCase()}`,
    lookup: `terrain_${key}_month`,
    product: `Terrain ${plan.label}`,
    description: `${platforms} · ${limit} · ${plan.seats} seat${plan.seats === 1 ? "" : "s"}`,
    interval: "month",
    usd: plan.monthlyUsd,
  });
  if (plan.annualUsd != null) {
    SPECS.push({
      env: `STRIPE_PRICE_${key.toUpperCase()}_YEAR`,
      lookup: `terrain_${key}_year`,
      product: `Terrain ${plan.label}`,          // same product, second price
      interval: "year",
      usd: plan.annualUsd,
      // 8x the monthly price = 4 months free. A dedicated annual price (rather than a
      // coupon) is what makes "2027 only" enforceable: archive the price, promo over.
      note: `${Math.round(12 - plan.annualUsd / plan.monthlyUsd)} months free vs monthly — 2027 promo, archive to end it`,
    });
  }
}
SPECS.push({
  env: "STRIPE_PRICE_SEAT",
  lookup: "terrain_seat_month",
  product: "Terrain extra seat",
  description: "One additional seat on any Terrain plan.",
  interval: "month",
  usd: EXTRA_SEAT_USD,
  note: "billed as an extra subscription item, quantity = seats over the plan's included count",
});
SPECS.push({
  env: "STRIPE_PRICE_ADDON_RADAR",
  lookup: "terrain_addon_radar_month",
  product: "Terrain Radar & Partners",
  description: "Radar brand monitoring + the Partners directory, on top of any Terrain plan.",
  interval: "month",
  usd: ADDON_RADAR_PARTNERS_USD,
  note: "NOT the standalone 'Radar Monitoring' product (R199/mo, sold to brands) — different buyer",
});

console.log(`Stripe account: ${LIVE ? "LIVE  ⚠" : "test"}`);
console.log(COMMIT ? "Mode: COMMIT — will create what's missing\n" : "Mode: DRY RUN — nothing will be created (pass --commit)\n");
if (LIVE && COMMIT) {
  console.log("⚠  This is a LIVE key. Prices created here are real and cannot be deleted, only archived.\n");
}

const productCache = new Map();
async function productFor(name, description) {
  if (productCache.has(name)) return productCache.get(name);
  // search is eventually consistent on fresh objects; list is exact enough at our size
  const existing = await stripe.products.list({ limit: 100, active: true });
  let product = existing.data.find((p) => p.name === name);
  if (!product) {
    if (!COMMIT) {
      product = { id: "(new product)", name };
      console.log(`  + would create product  ${name}`);
    } else {
      product = await stripe.products.create({ name, ...(description ? { description } : {}) });
      console.log(`  + created product       ${name}  ${product.id}`);
    }
  } else {
    console.log(`  = product exists        ${name}  ${product.id}`);
  }
  productCache.set(name, product);
  return product;
}

const out = {};
let mismatches = 0;

for (const spec of SPECS) {
  const amount = spec.usd * 100;                       // USD cents
  const label = `$${spec.usd.toLocaleString()}/${spec.interval === "year" ? "yr" : "mo"}`;
  console.log(`${spec.env}  —  ${label}  (${spec.lookup})`);
  if (spec.note) console.log(`  · ${spec.note}`);

  const found = await stripe.prices.list({ lookup_keys: [spec.lookup], active: true, limit: 1 });
  const price = found.data[0];

  if (price && price.unit_amount === amount && price.currency === "usd" && price.recurring?.interval === spec.interval) {
    console.log(`  = price exists          ${price.id}`);
    out[spec.env] = price.id;
    console.log();
    continue;
  }

  if (price) {
    const was = `$${(price.unit_amount / 100).toLocaleString()} ${price.currency.toUpperCase()}/${price.recurring?.interval}`;
    if (!REPLACE) {
      console.log(`  ✗ MISMATCH             ${price.id} is ${was}, plans.ts says ${label}`);
      console.log(`    Stripe prices are immutable. Re-run with --replace to point ${spec.lookup} at a new`);
      console.log(`    price; existing subscriptions stay on ${price.id} until migrated.`);
      mismatches++;
      console.log();
      continue;
    }
    console.log(`  ! replacing             ${price.id} (${was}) → ${label}`);
  }

  const product = await productFor(spec.product, spec.description);
  if (!COMMIT) {
    console.log(`  + would create price    ${label}`);
    out[spec.env] = "(pending --commit)";
    console.log();
    continue;
  }
  const created = await stripe.prices.create({
    product: product.id,
    unit_amount: amount,
    currency: "usd",
    recurring: { interval: spec.interval },
    lookup_key: spec.lookup,
    transfer_lookup_key: Boolean(price),               // only when deliberately replacing
    ...(spec.description ? { nickname: spec.description.slice(0, 100) } : {}),
  });
  console.log(`  + created price         ${created.id}`);
  out[spec.env] = created.id;
  console.log();
}

console.log("─".repeat(72));
console.log(`\nAdd these to .env.local AND Vercel (${LIVE ? "LIVE" : "test"} values):\n`);
for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);

// The two introductory prices predate the ladder. They are still read as a transitional
// fallback in lib/stripe.ts, so flag them rather than archiving anything automatically.
const stale = await stripe.products.list({ limit: 100, active: true });
const old = stale.data.filter((p) => ["Terrain Starter", "Terrain Pro"].includes(p.name));
if (old.length) {
  console.log(`\nStill active from the old ladder: ${old.map((p) => p.name).join(", ")}.`);
  console.log("Archive them in Stripe once STRIPE_PRICE_LEADS/INTELLIGENCE are set in every");
  console.log("environment — lib/stripe.ts falls back to STRIPE_PRICE_STARTER/PRO until then.");
}

if (mismatches) {
  console.log(`\n${mismatches} price(s) disagree with plans.ts. Nothing was changed for those.`);
  process.exit(1);
}
if (!COMMIT) console.log("\nDry run — nothing was created. Re-run with --commit.");
