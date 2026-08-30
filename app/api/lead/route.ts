/** Full detail for one store (every field we know), for the lead drawer.
 *  GET /api/lead?domain=example.co.za — gated to a signed-in subscriber. */

import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getSubscriber, hasAccess } from "@/lib/subscriptions";
import { getLeadDetail } from "@/lib/lead-detail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const email = await currentUser();
  if (!email) return NextResponse.json({ error: "Not authorised" }, { status: 401 });
  const subscriber = await getSubscriber(email).catch(() => null);
  if (!hasAccess(subscriber)) return NextResponse.json({ error: "No access" }, { status: 403 });

  const domain = new URL(req.url).searchParams.get("domain")?.trim().toLowerCase();
  if (!domain) return NextResponse.json({ error: "domain required" }, { status: 400 });

  const detail = await getLeadDetail(domain).catch(() => null);
  if (!detail) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(detail);
}
