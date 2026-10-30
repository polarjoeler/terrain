/** Start a Stripe subscription checkout (7-day trial, card required).
 *  Returns the hosted Stripe Checkout URL for the client to redirect to. */

import { NextResponse } from "next/server";
import { PLANS, resolvePlan } from "@/lib/plans";
import type { Period } from "@/lib/stripe";
import { currentUser } from "@/lib/auth";
import { createCheckoutSession } from "@/lib/stripe";
import { type PlanKey } from "@/lib/subscriptions";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function POST(req: Request) {
  let body: { email?: string; plan?: string; period?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  // Prefer the signed-in user; fall back to a supplied email for signup-from-pricing.
  const email = ((await currentUser()) ?? body.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json(
      { error: "Sign in first, or enter a valid email address" },
      { status: 400 },
    );
  }

  // resolvePlan accepts the new keys and still maps legacy starter/pro from any
  // client that has not reloaded.
  const plan: PlanKey = resolvePlan(body.plan);
  const period: Period = body.period === "year" ? "year" : "month";
  // Leads is monthly-only by design. Without this the missing price surfaces as a 502,
  // which reads as "our Stripe is broken" rather than "that plan has no annual option".
  if (period === "year" && PLANS[plan].annualUsd == null) {
    return NextResponse.json(
      { error: `${PLANS[plan].label} is billed monthly only.` },
      { status: 400 },
    );
  }
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? new URL(req.url).origin;

  try {
    const url = await createCheckoutSession({ email, plan, period, origin });
    return NextResponse.json({ url });
  } catch (err) {
    console.error("[terrain] stripe checkout failed:", err);
    const msg = err instanceof Error ? err.message : "Could not start checkout";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
