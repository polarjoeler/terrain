/** Stripe client + subscription checkout.
 *
 * Model: a customer signs in (magic link), then subscribes via Stripe Checkout.
 * Checkout collects a card up front and starts a 7-day trial (Stripe manages the
 * trial and the first charge). Access in the app is driven by Stripe webhooks
 * updating the subscriber record — see app/api/webhooks/stripe/route.ts.
 */

import Stripe from "stripe";
import { TRIAL_DAYS, type PlanKey, type Status } from "./subscriptions";
import { resolvePlan } from "./plans";

let _stripe: Stripe | null = null;

export function stripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
    _stripe = new Stripe(key);
  }
  return _stripe;
}

/** Stripe price id per plan and billing period. Env-driven so the same code runs against
 *  test and live keys. Annual exists only for Intelligence and Partner — the 2027 promo
 *  (4 months free); Leads is monthly-only on purpose. */
const PRICE_ENV: Record<PlanKey, { month: string; year?: string }> = {
  leads: { month: "STRIPE_PRICE_LEADS" },
  intelligence: { month: "STRIPE_PRICE_INTELLIGENCE", year: "STRIPE_PRICE_INTELLIGENCE_YEAR" },
  partner: { month: "STRIPE_PRICE_PARTNER", year: "STRIPE_PRICE_PARTNER_YEAR" },
};

/** Add-ons billed as extra subscription items, not plans. */
export const SEAT_PRICE_ENV = "STRIPE_PRICE_SEAT";
export const ADDON_RADAR_PRICE_ENV = "STRIPE_PRICE_ADDON_RADAR";

export type Period = "month" | "year";

export function priceIdFor(plan: PlanKey, period: Period = "month"): string | undefined {
  const map = PRICE_ENV[plan];
  const name = period === "year" ? map.year : map.month;
  if (!name) return undefined;
  const id = process.env[name];
  if (id) return id;
  // Transitional: the first two price ids were created as STARTER/PRO before the tiers
  // were renamed. Fall back so a half-migrated environment still checks out rather than
  // 500ing, and so the rename can ship ahead of creating the new Stripe objects.
  if (period === "month" && plan === "leads") return process.env.STRIPE_PRICE_STARTER;
  if (period === "month" && plan === "intelligence") return process.env.STRIPE_PRICE_PRO;
  return undefined;
}

/** Hosted Checkout URL for a subscription with a card-required 7-day trial. */
export async function createCheckoutSession(opts: {
  email: string;
  plan: PlanKey;
  /** month (default) or the 2027 annual price, where the plan offers one. */
  period?: Period;
  origin: string;
}): Promise<string> {
  const period = opts.period ?? "month";
  const price = priceIdFor(opts.plan, period);
  if (!price) {
    throw new Error(
      `No Stripe price for '${opts.plan}' (${period}). Run scripts/setup-stripe.mjs and set STRIPE_PRICE_*`,
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
      metadata: { plan: opts.plan, period, product: "terrain" },
    },
    metadata: { plan: opts.plan, period, email: opts.email },
    allow_promotion_codes: true,
    success_url: `${opts.origin}/dashboard?welcome=1`,
    cancel_url: `${opts.origin}/billing`,
  });
  if (!session.url) throw new Error("Stripe returned no checkout URL");
  return session.url;
}

/** Hosted Checkout for a Radar monitoring subscription (separate product).
 *  Keyed to the brand via subscription metadata so the webhook can find it. */
export async function createRadarCheckoutSession(opts: {
  email?: string;
  brandDomain: string;
  origin: string;
}): Promise<string> {
  const price = process.env.STRIPE_PRICE_RADAR;
  if (!price) {
    throw new Error("No STRIPE_PRICE_RADAR set. Run scripts/setup-radar-stripe.mjs and set it.");
  }
  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    customer_email: opts.email || undefined,
    payment_method_collection: "always",
    subscription_data: { metadata: { product: "radar", brand_domain: opts.brandDomain } },
    metadata: { product: "radar", brand_domain: opts.brandDomain, email: opts.email ?? null },
    allow_promotion_codes: true,
    success_url: `${opts.origin}/dashboard?welcome=1`,
    cancel_url: `${opts.origin}/`,
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
  // resolvePlan maps legacy starter/pro metadata on subscriptions created before the
  // rename, so existing Stripe objects keep resolving to the right entitlements.
  return resolvePlan(meta?.plan);
}
