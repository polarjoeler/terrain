import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { currentUser } from "@/lib/auth";
import { ONBOARDING_SKIP_COOKIE } from "@/lib/profile";

/** "Skip for now" on the setup screen. Records the choice as a cookie so the sign-in redirect
 *  (app/api/auth/verify) stops diverting this browser to /onboarding.
 *
 *  POST, not GET: Next prefetches links, so a GET route here would be fired by merely rendering
 *  the skip link and would silently skip setup for everyone. */
export async function POST() {
  const email = await currentUser();
  if (!email) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  (await cookies()).set(ONBOARDING_SKIP_COOKIE, "1", {
    path: "/",
    maxAge: 180 * 24 * 60 * 60,
    sameSite: "lax",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
  });
  return NextResponse.json({ ok: true });
}
