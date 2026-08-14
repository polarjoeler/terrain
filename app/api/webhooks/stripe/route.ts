/** Stripe webhook receiver — the source of truth for subscription access.
 *
 * SECURITY: verifies the Stripe signature against the RAW body. Never parse
 * before verifying.
 *
 * We key everything on the customer's email (set as customer_email at checkout).
 * Access in the app follows the Stripe subscription status via mapStatus().
 */

import { NextResponse } from "next/server";
import Stripe from "stripe";
import { mapStatus, planFromMetadata, stripe } from "@/lib/stripe";
import { upsertSubscriber } from "@/lib/subscriptions";

export const runtime = "nodejs";

function iso(unixSeconds: number | null | undefined): string | null {
  return unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null;
}

async function applySubscription(sub: Stripe.Subscription, email?: string | null) {
  // Resolve the email from the customer if not already known.
  let addr = email ?? null;
  if (!addr && typeof sub.customer === "string") {
    const cust = await stripe().customers.retrieve(sub.customer);
    if (cust && !cust.deleted) addr = cust.email;
  }
  if (!addr) return;

  // In the latest Stripe API the billing period lives on the subscription item.
  const periodEnd = sub.items?.data?.[0]?.current_period_end ?? null;
  await upsertSubscriber(addr, {
    plan: planFromMetadata(sub.metadata),
    status: mapStatus(sub.status),
    trialEndsAt: iso(sub.trial_end),
    nextPaymentDate: iso(periodEnd),
    customerCode: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
    subscriptionCode: sub.id,
  });
}

export async function POST(req: Request) {
  const raw = await req.text();
  const sig = req.headers.get("stripe-signature");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!sig || !secret) {
    return new NextResponse("missing signature/secret", { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(raw, sig, secret);
  } catch (err) {
    console.error("[terrain] stripe signature verification failed:", err);
    return new NextResponse("invalid signature", { status: 401 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        if (s.subscription) {
          const sub = await stripe().subscriptions.retrieve(
            typeof s.subscription === "string" ? s.subscription : s.subscription.id,
          );
          await applySubscription(sub, s.customer_email ?? s.customer_details?.email);
        }
        break;
      }
      // subscription.updated also fires on payment failure (status → past_due)
      // and on cancellation, so it covers the whole lifecycle.
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        await applySubscription(event.data.object as Stripe.Subscription);
        break;
      }
      default:
        return NextResponse.json({ received: true, ignored: event.type });
    }
  } catch (err) {
    console.error(`[terrain] error handling ${event.type}:`, err);
    // 500 so Stripe retries.
    return new NextResponse("handler error", { status: 500 });
  }

  return NextResponse.json({ received: true, event: event.type });
}
