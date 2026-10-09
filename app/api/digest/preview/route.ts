/** Preview the weekly digest with live data (admin-only). Renders the HTML. */

import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { buildDigest } from "@/lib/digest";
import { publishedLeads } from "@/lib/imported";
import { digestSnapshot } from "@/lib/insights";
import { buildProviderDigestData, renderProviderDigest } from "@/lib/provider-digest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isAdmin(await currentUser())) {
    return NextResponse.json({ error: "Not authorised" }, { status: 403 });
  }
  const url = new URL(req.url);
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? url.origin;

  // Provider digest preview: /api/digest/preview?provider=Paystack[&markets=ZA,KE,NG][&platform=all]
  const provider = url.searchParams.get("provider");
  if (provider) {
    const markets = (url.searchParams.get("markets") || "ZA,KE,NG").toUpperCase().split(",").map((s) => s.trim()).filter(Boolean);
    const platform = url.searchParams.get("platform") || "all";
    const data = await buildProviderDigestData(provider, markets, platform);
    const { html } = renderProviderDigest(data, siteUrl);
    return new NextResponse(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  // Default: the leads digest. Same Postgres universe as the dashboard / insights, so the email agrees.
  const [leads, insights] = await Promise.all([publishedLeads(), digestSnapshot()]);
  const { html } = buildDigest({ leads, insights, siteUrl });
  return new NextResponse(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
