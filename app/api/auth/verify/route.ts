/** Redeem a magic link and start a session. */

import { NextResponse } from "next/server";
import { redeemMagicToken, startSession, originFromRequest } from "@/lib/auth";

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
  return NextResponse.redirect(`${origin}/dashboard`);
}
