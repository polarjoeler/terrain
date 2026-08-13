/** Email a magic sign-in link. Starts a trial for first-time addresses. */

import { NextResponse } from "next/server";
import { createMagicToken } from "@/lib/auth";
import { sendMagicLink } from "@/lib/email";
import { getSubscriber, startTrial } from "@/lib/subscriptions";

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

  // New address? Give them a trial so the link lands somewhere useful.
  const existing = await getSubscriber(email);
  if (!existing) await startTrial(email);

  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? new URL(req.url).origin;
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
