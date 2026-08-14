/** Stripe client + subscription checkout.
 *
 * Model: a customer signs in (magic link), then subscribes via Stripe Checkout.
 * Checkout collects a card up front and starts a 7-day trial (Stripe manages the
 * trial and the first charge). Access in the app is driven by Stripe webhooks
 * updating the subscriber record — see app/api/webhooks/stripe/route.ts.
 */

import Stripe from "stripe";
import { TRIAL_DAYS, type PlanKey, type Status } from "./subscriptions";

let _stripe: Stripe | null = null;

export function stripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
    _stripe = new Stripe(key);
  }
  return _stripe;
}

export function priceIdFor(plan: PlanKey): string | undefined {
  return plan === "pro"
    ? process.env.STRIPE_PRICE_PRO
    : process.env.STRIPE_PRICE_STARTER;
}

/** Hosted Checkout URL for a subscription with a card-required 7-day trial. */
export async function createCheckoutSession(opts: {
  email: string;
  plan: PlanKey;
  origin: string;
}): Promise<string> {
  const price = priceIdFor(opts.plan);
  if (!price) {
    throw new Error(
      `No Stripe price for '${opts.plan}'. Run scripts/setup-stripe.mjs and set STRIPE_PRICE_*`,
    );
  }
  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    customer_email: opts.email,
    // Card up front, even though the first 7 days are free.
    payment_method_collection: "always",
    subscription_data: {
      trial_period_days: TRIAL_DAYS,
      metadata: { plan: opts.plan, product: "terrain" },
    },
    metadata: { plan: opts.plan, email: opts.email },
    allow_promotion_codes: true,
    success_url: `${opts.origin}/dashboard?welcome=1`,
    cancel_url: `${opts.origin}/billing`,
  });
  if (!session.url) throw new Error("Stripe returned no checkout URL");
  return session.url;
}

/** Map a Stripe subscription status to our internal status. */
export function mapStatus(s: Stripe.Subscription.Status): Status {
  switch (s) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
      return "cancelled";
    default:
      return "expired"; // incomplete / incomplete_expired / paused
  }
}

export function planFromMetadata(meta: Stripe.Metadata | null | undefined): PlanKey {
  return meta?.plan === "pro" ? "pro" : "starter";
}
