/** Preview the weekly digest with live data (admin-only). Renders the HTML. */

import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { buildDigest } from "@/lib/digest";
import { publishedLeads } from "@/lib/imported";
import { digestSnapshot } from "@/lib/insights";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isAdmin(await currentUser())) {
    return NextResponse.json({ error: "Not authorised" }, { status: 403 });
  }
  // Same Postgres universe as the dashboard / insights, so the email agrees.
  const [leads, insights] = await Promise.all([publishedLeads(), digestSnapshot()]);
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? new URL(req.url).origin;
  const { html } = buildDigest({ leads, insights, siteUrl });
  return new NextResponse(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
