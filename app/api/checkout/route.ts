/** Convert a trial (or sign up directly) into a paid Paystack subscription.
 *  Returns the hosted Paystack checkout URL for the client to redirect to. */

import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { initializeSubscription } from "@/lib/paystack";
import { upsertSubscriber, type PlanKey } from "@/lib/subscriptions";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function planCode(plan: PlanKey): string | undefined {
  return plan === "pro"
    ? process.env.PAYSTACK_PLAN_PRO
    : process.env.PAYSTACK_PLAN_STARTER;
}

export async function POST(req: Request) {
  let body: { email?: string; plan?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  // Signed-in users are billed against their session; the body email is only a
  // fallback for signing up straight from the pricing page.
  const email = ((await currentUser()) ?? body.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json(
      { error: "Sign in first, or enter a valid email address" },
      { status: 400 },
    );
  }

  const plan: PlanKey = body.plan === "pro" ? "pro" : "starter";
  const code = planCode(plan);
  if (!code) {
    return NextResponse.json(
      { error: `No Paystack plan configured for '${plan}'. Run scripts/setup-plans.mjs.` },
      { status: 500 },
    );
  }

  const origin =
    process.env.NEXT_PUBLIC_SITE_URL ?? new URL(req.url).origin;

  try {
    const init = await initializeSubscription({
      email,
      planCode: code,
      callbackUrl: `${origin}/welcome`,
      metadata: { plan, product: "terrain" },
    });
    // Record intent; the webhook flips status to active once payment lands.
    await upsertSubscriber(email, { plan });
    return NextResponse.json({ url: init.authorization_url, reference: init.reference });
  } catch (err) {
    console.error("[terrain] checkout failed:", err);
    return NextResponse.json({ error: "Could not start checkout" }, { status: 502 });
  }
}
