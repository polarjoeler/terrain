import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { getSubscriber, hasAccess } from "@/lib/subscriptions";
import { platformGrowthSeries } from "@/lib/provider-insights";

export const dynamic = "force-dynamic";

/** Cumulative platform-growth series (Shopify vs WooCommerce) for the combined insights view.
 *  Paid-gated (proprietary). Params: country (YYYY-MM-DD launch cohorts, monthly cumulative). */
export async function GET(req: Request) {
  const email = await currentUser();
  if (!email) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const subscriber = await getSubscriber(email).catch(() => null);
  if (!hasAccess(subscriber) && !isAdmin(email)) return NextResponse.json({ error: "No access" }, { status: 403 });

  const p = new URL(req.url).searchParams;
  const data = await platformGrowthSeries(p.get("country") || undefined, p.get("provider") || undefined).catch(() => null);
  if (!data) return NextResponse.json({ error: "failed" }, { status: 500 });
  return NextResponse.json(data);
}
