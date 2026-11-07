/** The signed-in user's own digest, rendered as HTML — exactly what the send job would build for
 *  them this week (same focus, same leads). Powers "Preview this week's email" on /digests. Only
 *  ever the caller's own digest: the email comes from the session, never a parameter. */
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { buildDigest } from "@/lib/digest";
import { digestLeadLoader } from "@/lib/digest-leads";
import { digestSnapshot } from "@/lib/insights";
import { getFocus } from "@/lib/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const email = await currentUser();
  if (!email) return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? new URL(req.url).origin;
  // Sequential, not Promise.all: the small pool.
  const focus = await getFocus(email);
  const leads = await digestLeadLoader()(focus);
  const insights = await digestSnapshot().catch(() => null);
  const { html } = buildDigest({ leads, insights, siteUrl, focus });
  return new NextResponse(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store" } });
}
