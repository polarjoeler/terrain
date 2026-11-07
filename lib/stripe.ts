/** Stripe client + subscription checkout.
 *
 * Model: a customer signs in (magic link), then subscribes via Stripe Checkout.
 * Checkout collects a card up front and starts a 7-day trial (Stripe manages the
 * trial and the first charge). Access in the app is driven by Stripe webhooks
 * updating the subscriber record — see app/api/webhooks/stripe/route.ts.
 */

import Stripe from "stripe";
import { TRIAL_DAYS, type PlanKey, type Status } from "./subscriptions";
import { MAX_EXTRA_SEATS, resolvePlan } from "./plans";

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

/** Seat lookup keys, per interval. Stripe refuses to mix billing intervals within one
 *  subscription, so an annual plan can only take an annual seat — adding the monthly seat price
 *  to it fails outright rather than prorating. Same lookup-key discipline as the plans above. */
const SEAT_LOOKUP: Record<Period, string> = { month: "terrain_seat_month", year: "terrain_seat_year" };

/** The seat price for an interval, or undefined when it hasn't been created in this Stripe mode. */
export async function seatPriceId(period: Period = "month"): Promise<string | undefined> {
  // The env override applies to the monthly seat only — it predates annual seats, and a single
  // pinned id can't serve both intervals.
  const pinned = period === "month" ? process.env[SEAT_PRICE_ENV] : undefined;
  if (pinned) return pinned;
  const key = SEAT_LOOKUP[period];
  const cached = _priceCache.get(key);
  if (cached) return cached;
  const found = await stripe().prices.list({ lookup_keys: [key], active: true, limit: 1 });
  const id = found.data[0]?.id;
  if (id) _priceCache.set(key, id);
  return id;
}

/** Clamp a requested seat count to something chargeable. */
export function normaliseSeats(n: unknown): number {
  const v = Math.trunc(Number(n));
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(MAX_EXTRA_SEATS, v);
}

const isSeatItem = (item: Stripe.SubscriptionItem): boolean =>
  Object.values(SEAT_LOOKUP).includes(item.price?.lookup_key ?? "");

/** The subscription's seat line item, if any. Identified by the price's LOOKUP KEY rather than by
 *  a resolved id, so it costs no API call and cannot mismatch across test/live. */
export const seatItemOf = (sub: Stripe.Subscription): Stripe.SubscriptionItem | undefined =>
  sub.items?.data?.find(isSeatItem);

/** The plan line item. Not `items.data[0]` — once a seat item exists, the order is Stripe's. */
export const planItemOf = (sub: Stripe.Subscription): Stripe.SubscriptionItem | undefined =>
  sub.items?.data?.find((i) => !isSeatItem(i)) ?? sub.items?.data?.[0];

/** Seats bought on top of the plan's included count. */
export const seatQuantityOf = (sub: Stripe.Subscription): number => seatItemOf(sub)?.quantity ?? 0;

/** Set the paid extra-seat count on a live subscription, prorating the difference.
 *
 *  Adds the item, changes its quantity, or removes it at zero. The interval is taken from the
 *  PLAN item rather than assumed, so an annual subscriber gets the annual seat price. */
export async function setSeatQuantity(subscriptionId: string, extraSeats: number): Promise<number> {
  const seats = normaliseSeats(extraSeats);
  const sub = await stripe().subscriptions.retrieve(subscriptionId);
  const existing = seatItemOf(sub);

  if (seats === 0) {
    if (existing) await stripe().subscriptionItems.del(existing.id, { proration_behavior: "create_prorations" });
    return 0;
  }

  if (existing) {
    if (existing.quantity === seats) return seats;
    await stripe().subscriptionItems.update(existing.id, { quantity: seats, proration_behavior: "create_prorations" });
    return seats;
  }

  const period: Period = planItemOf(sub)?.price?.recurring?.interval === "year" ? "year" : "month";
  const price = await seatPriceId(period);
  if (!price) {
    throw new Error(
      `No Stripe seat price for ${period}ly billing (lookup key '${SEAT_LOOKUP[period]}'). ` +
        "Run scripts/setup-stripe.mjs --commit in this Stripe mode.",
    );
  }
  await stripe().subscriptionItems.create({
    subscription: subscriptionId, price, quantity: seats, proration_behavior: "create_prorations",
  });
  return seats;
}

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
  /** Seats beyond the plan's included count, billed as a second line item. */
  extraSeats?: number;
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
  const line_items: Stripe.Checkout.SessionCreateParams.LineItem[] = [{ price, quantity: 1 }];
  const seats = normaliseSeats(opts.extraSeats);
  if (seats > 0) {
    // Matched to the plan's interval — Stripe rejects a subscription whose items disagree.
    const seatPrice = await seatPriceId(period);
    if (!seatPrice) {
      throw new Error(
        `No Stripe seat price for ${period}ly billing (lookup key '${SEAT_LOOKUP[period]}'). ` +
          "Run scripts/setup-stripe.mjs --commit in this Stripe mode.",
      );
    }
    line_items.push({ price: seatPrice, quantity: seats });
  }
  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    line_items,
    customer_email: opts.email,
    // Card up front, even though the first 7 days are free.
    payment_method_collection: "always",
    subscription_data: {
      trial_period_days: TRIAL_DAYS,
      metadata: { plan: opts.plan, period, product: "terrain" },
    },
    metadata: { plan: opts.plan, period, email: opts.email, extra_seats: String(seats) },
    allow_promotion_codes: true,
    // {CHECKOUT_SESSION_ID} is substituted by Stripe. /welcome uses it to identify a buyer
    // who checked out without being signed in; a signed-in visitor is identified by cookie.
    success_url: `${opts.origin}/welcome?session_id={CHECKOUT_SESSION_ID}`,
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
