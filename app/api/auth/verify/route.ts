/** Redeem a magic link and start a session. */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { redeemMagicToken, startSession, originFromRequest } from "@/lib/auth";
import { recordLogin, ipOf } from "@/lib/sessions";
import { ONBOARDING_SKIP_COOKIE, hasCompletedOnboarding } from "@/lib/profile";
import { grantTrial } from "@/lib/subscriptions";
import { acceptInvites } from "@/lib/seats";
import { resolvePlan } from "@/lib/plans";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  // Redirect back to the host the link was for (radar stays on radar, where
  // /dashboard rewrites to /radar/dashboard).
  const origin = originFromRequest(req);

  let redeemed: Awaited<ReturnType<typeof redeemMagicToken>> = null;
  try {
    redeemed = await redeemMagicToken(token);
  } catch {
    // DB couldn't be reached even after retries (pooler saturated) — send them back to try again
    // rather than a 500. The token is still unburned, so a retry works once the DB has a free moment.
    return NextResponse.redirect(`${origin}/login?error=retry`);
  }
  if (!redeemed) {
    return NextResponse.redirect(`${origin}/login?error=expired`);
  }
  const { email, grant } = redeemed;

  // An admin invite link carries the access it was minted with. Apply it BEFORE the session starts,
  // so the very first page they land on already sees them as entitled rather than bouncing them to
  // /billing. grantTrial never downgrades an existing subscriber. Best-effort: if it fails we still
  // sign them in — an admin can set the plan by hand, whereas a failed sign-in is a dead link.
  if (grant) {
    try { await grantTrial(email, resolvePlan(grant.plan), grant.days); }
    catch (e) { console.error(`[terrain] invite grant failed for ${email}:`, e); }
  }

  await startSession(email);
  // Record where this seat signed in from (anti-sharing signal) — best-effort, MUST NOT block or fail
  // sign-in: the session cookie is already set, so a DB hiccup here can't be allowed to 500 the login.
  try { await recordLogin(email, ipOf(req), req.headers.get("user-agent") ?? ""); } catch { /* ignore */ }

  // Flip any invite for this address from pending to accepted. Cosmetic only — a pending invite
  // already holds its seat (lib/seats.ts), so this just stops the roster calling an active
  // teammate "Pending". Must never break sign-in.
  try { await acceptInvites(email); } catch { /* ignore */ }

  // Send a user who has never completed setup to /onboarding instead of straight to the dashboard —
  // otherwise the screen only exists behind a link most people never click. Skippable: once they
  // choose "skip for now" the cookie stops the diversion, so this asks once rather than every visit.
  // Wrapped: the session cookie is already set, so nothing here may be allowed to break sign-in.
  let dest = "/dashboard";
  try {
    const skipped = (await cookies()).get(ONBOARDING_SKIP_COOKIE)?.value === "1";
    if (!skipped && !(await hasCompletedOnboarding(email))) dest = "/onboarding";
  } catch { /* fall back to the dashboard */ }
  return NextResponse.redirect(`${origin}${dest}`);
}
