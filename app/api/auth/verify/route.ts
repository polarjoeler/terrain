/** Redeem a magic link and start a session. */

import { NextResponse } from "next/server";
import { redeemMagicToken, startSession } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? url.origin;

  const email = await redeemMagicToken(token);
  if (!email) {
    return NextResponse.redirect(`${origin}/login?error=expired`);
  }

  await startSession(email);
  return NextResponse.redirect(`${origin}/dashboard`);
}
