/** Preview the weekly digest with live data (admin-only). Renders the HTML. */

import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { buildDigest } from "@/lib/digest";
import { fetchInsights, fetchLeads } from "@/lib/sheets";
import { marketOf } from "@/lib/prioritize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isAdmin(await currentUser())) {
    return NextResponse.json({ error: "Not authorised" }, { status: 403 });
  }
  const [{ leads }, { latest }] = await Promise.all([fetchLeads(), fetchInsights()]);
  const africa = leads.filter((l) => marketOf(l) !== "Japan");
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? new URL(req.url).origin;
  const { html } = buildDigest({ leads: africa, insights: latest, siteUrl });
  return new NextResponse(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
