/** Start a no-card free trial. */

import { NextResponse } from "next/server";
import { startTrial, TRIAL_DAYS, type PlanKey } from "@/lib/subscriptions";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function POST(req: Request) {
  let body: { email?: string; plan?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const email = (body.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
  }

  const plan: PlanKey = body.plan === "pro" ? "pro" : "starter";
  const { subscriber, created } = await startTrial(email, plan);

  return NextResponse.json({
    ok: true,
    created,
    trialDays: TRIAL_DAYS,
    trialEndsAt: subscriber.trialEndsAt,
    status: subscriber.status,
    message: created
      ? `Trial started — ${TRIAL_DAYS} days of full access.`
      : "You already have an account.",
  });
}
