#!/usr/bin/env node
/** One-off: create the Radar monitoring product + price in your Stripe account.
 *
 *   node --env-file=.env.local scripts/setup-radar-stripe.mjs
 *
 * Prints STRIPE_PRICE_RADAR to paste into your env (.env.local AND Vercel).
 * Idempotent: reuses a product/price with the same name/amount. R199/mo (ZAR).
 * Uses the same Stripe account as Terrain (STRIPE_SECRET_KEY).
 */

import Stripe from "stripe";

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY) {
  console.error("Set STRIPE_SECRET_KEY first (in .env.local).");
  process.exit(1);
}
const stripe = new Stripe(KEY);

const NAME = "Radar Monitoring";
const AMOUNT = 19900; // R199.00 in ZAR cents
const CURRENCY = "zar";

const products = await stripe.products.list({ limit: 100, active: true });
let product = products.data.find((p) => p.name === NAME);
if (!product) {
  product = await stripe.products.create({ name: NAME, description: "Continuous clone monitoring for your brand." });
  console.log(`+ created product ${NAME}`);
} else {
  console.log(`= product ${NAME} exists`);
}

const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
let price = prices.data.find(
  (p) => p.unit_amount === AMOUNT && p.currency === CURRENCY && p.recurring?.interval === "month",
);
if (!price) {
  price = await stripe.prices.create({
    product: product.id,
    unit_amount: AMOUNT,
    currency: CURRENCY,
    recurring: { interval: "month" },
  });
  console.log(`+ created price R${AMOUNT / 100}/mo (${price.id})`);
} else {
  console.log(`= price exists (${price.id})`);
}

console.log(`\nAdd this to your env (.env.local and Vercel):\n\nSTRIPE_PRICE_RADAR=${price.id}\n`);
