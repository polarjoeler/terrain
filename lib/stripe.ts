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

/** Stripe price id per plan and billing period, as an explicit override. Annual exists only
 *  for Intelligence and Partner — the 2027 promo (4 months free); Leads is monthly-only. */
const PRICE_ENV: Record<PlanKey, { month: string; year?: string }> = {
  leads: { month: "STRIPE_PRICE_LEADS" },
  intelligence: { month: "STRIPE_PRICE_INTELLIGENCE", year: "STRIPE_PRICE_INTELLIGENCE_YEAR" },
  partner: { month: "STRIPE_PRICE_PARTNER", year: "STRIPE_PRICE_PARTNER_YEAR" },
};

/** Stripe `lookup_key` per plan and period — the SAME keys scripts/setup-stripe.mjs writes,
 *  and the ones set by hand on the live prices.
 *
 *  Resolving by lookup key rather than by id is what makes a test→live switch safe. A price id
 *  only exists in the mode that created it, so an id pinned in env is silently wrong the moment
 *  the secret key changes mode — which is exactly how production ended up on sandbox prices.
 *  A lookup key is resolved against whichever mode the key is in, so it cannot disagree. */
const PRICE_LOOKUP: Record<PlanKey, { month: string; year?: string }> = {
  leads: { month: "terrain_leads_month" },
  intelligence: { month: "terrain_intelligence_month", year: "terrain_intelligence_year" },
  partner: { month: "terrain_partner_month", year: "terrain_partner_year" },
};

/** Resolved ids, per process. Keyed by lookup key, so a mode change (new key, new lambda)
 *  never reads a stale id. */
const _priceCache = new Map<string, string>();

/** Add-ons billed as extra subscription items, not plans. */
export const SEAT_PRICE_ENV = "STRIPE_PRICE_SEAT";
export const ADDON_RADAR_PRICE_ENV = "STRIPE_PRICE_ADDON_RADAR";

export type Period = "month" | "year";

export async function priceIdFor(plan: PlanKey, period: Period = "month"): Promise<string | undefined> {
  // 1. An explicit id in env always wins — the escape hatch for a one-off price.
  const envName = period === "year" ? PRICE_ENV[plan].year : PRICE_ENV[plan].month;
  const pinned = envName ? process.env[envName] : undefined;
  if (pinned) return pinned;

  // 2. Otherwise resolve the lookup key in whatever mode STRIPE_SECRET_KEY is in.
  const key = period === "year" ? PRICE_LOOKUP[plan].year : PRICE_LOOKUP[plan].month;
  if (!key) return undefined;                       // Leads has no annual price, by design
  const cached = _priceCache.get(key);
  if (cached) return cached;

  const found = await stripe().prices.list({ lookup_keys: [key], active: true, limit: 1 });
  const id = found.data[0]?.id;
  if (id) _priceCache.set(key, id);
  return id;
}

/* The STRIPE_PRICE_STARTER / STRIPE_PRICE_PRO fallback that used to live here is gone. Those
   are sandbox ids from the pre-rename ladder; once the secret key goes live they resolve to
   prices that don't exist in live mode, and checkout fails with "No such price". The lookup
   above makes them unnecessary. */

/** Hosted Checkout URL for a subscription with a card-required 7-day trial. */
export async function createCheckoutSession(opts: {
  email: string;
  plan: PlanKey;
  /** month (default) or the 2027 annual price, where the plan offers one. */
  period?: Period;
  origin: string;
}): Promise<string> {
  const period = opts.period ?? "month";
  const price = await priceIdFor(opts.plan, period);
  if (!price) {
    throw new Error(
      `No Stripe price for '${opts.plan}' (${period}). Expected lookup key ` +
        `'${period === "year" ? PRICE_LOOKUP[opts.plan].year : PRICE_LOOKUP[opts.plan].month}' ` +
        `in this Stripe mode — run scripts/setup-stripe.mjs, or set ${PRICE_ENV[opts.plan].month}.`,
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
