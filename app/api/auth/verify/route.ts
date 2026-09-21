/** Redeem a magic link and start a session. */

import { NextResponse } from "next/server";
import { redeemMagicToken, startSession, originFromRequest } from "@/lib/auth";
import { recordLogin, ipOf } from "@/lib/sessions";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  // Redirect back to the host the link was for (radar stays on radar, where
  // /dashboard rewrites to /radar/dashboard).
  const origin = originFromRequest(req);

  const email = await redeemMagicToken(token);
  if (!email) {
    return NextResponse.redirect(`${origin}/login?error=expired`);
  }

  await startSession(email);
  // Record where this seat signed in from (anti-sharing signal) — best-effort.
  await recordLogin(email, ipOf(req), req.headers.get("user-agent") ?? "");
  return NextResponse.redirect(`${origin}/dashboard`);
}
