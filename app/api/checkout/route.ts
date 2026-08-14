/** Start a Stripe subscription checkout (7-day trial, card required).
 *  Returns the hosted Stripe Checkout URL for the client to redirect to. */

import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { createCheckoutSession } from "@/lib/stripe";
import { type PlanKey } from "@/lib/subscriptions";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function POST(req: Request) {
  let body: { email?: string; plan?: string };
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

  const plan: PlanKey = body.plan === "pro" ? "pro" : "starter";
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? new URL(req.url).origin;

  try {
    const url = await createCheckoutSession({ email, plan, origin });
    return NextResponse.json({ url });
  } catch (err) {
    console.error("[terrain] stripe checkout failed:", err);
    const msg = err instanceof Error ? err.message : "Could not start checkout";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
