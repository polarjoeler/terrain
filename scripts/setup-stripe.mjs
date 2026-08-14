#!/usr/bin/env node
/** One-off: create the Terrain products + prices in your Stripe account.
 *
 *   STRIPE_SECRET_KEY=sk_test_xxx node scripts/setup-stripe.mjs
 *
 * Prints the price IDs to paste into your env (STRIPE_PRICE_STARTER/PRO).
 * Idempotent: reuses a product with the same name instead of duplicating.
 * Uses introductory USD pricing ($30 / $79 per month).
 */

import Stripe from "stripe";

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY) {
  console.error("Set STRIPE_SECRET_KEY first (use your sk_test_ key to trial this).");
  process.exit(1);
}
const stripe = new Stripe(KEY);

// USD cents.
const PLANS = [
  { name: "Terrain Starter", amount: 3000, key: "STRIPE_PRICE_STARTER" },
  { name: "Terrain Pro", amount: 7900, key: "STRIPE_PRICE_PRO" },
];

const out = {};
const existingProducts = await stripe.products.list({ limit: 100, active: true });

for (const spec of PLANS) {
  let product = existingProducts.data.find((p) => p.name === spec.name);
  if (!product) {
    product = await stripe.products.create({ name: spec.name });
    console.log(`+ created product ${spec.name}`);
  } else {
    console.log(`= product ${spec.name} exists`);
  }

  // Reuse a matching monthly USD price if one already exists.
  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  let price = prices.data.find(
    (p) =>
      p.unit_amount === spec.amount &&
      p.currency === "usd" &&
      p.recurring?.interval === "month",
  );
  if (!price) {
    price = await stripe.prices.create({
      product: product.id,
      unit_amount: spec.amount,
      currency: "usd",
      recurring: { interval: "month" },
    });
    console.log(`+ created price $${spec.amount / 100}/mo (${price.id})`);
  } else {
    console.log(`= price exists (${price.id})`);
  }
  out[spec.key] = price.id;
}

console.log("\nAdd these to your env (.env.local and Vercel):\n");
for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
