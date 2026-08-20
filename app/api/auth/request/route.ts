/** Email a magic sign-in link. Access itself comes from a Stripe subscription
 *  (the dashboard sends users without one to /billing to start their trial). */

import { NextResponse } from "next/server";
import { createMagicToken, originFromRequest } from "@/lib/auth";
import { sendMagicLink } from "@/lib/email";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function POST(req: Request) {
  let body: { email?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const email = (body.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
  }

  // Host-aware: a Radar-host login gets a radar.* link and returns to Radar.
  const origin = originFromRequest(req);
  const url = `${origin}/api/auth/verify?token=${encodeURIComponent(createMagicToken(email))}`;

  let devPreview: string | undefined;
  try {
    const result = await sendMagicLink(email, url);
    if (!result.delivered && process.env.NODE_ENV !== "production") {
      devPreview = url; // no mail provider configured locally
    }
  } catch (err) {
    console.error("[terrain] magic link send failed:", err);
    return NextResponse.json({ error: "Could not send email" }, { status: 502 });
  }

  // Always the same response shape — don't reveal whether an account exists.
  return NextResponse.json({
    ok: true,
    message: "Check your email for a sign-in link.",
    ...(devPreview ? { devPreview } : {}),
  });
}
