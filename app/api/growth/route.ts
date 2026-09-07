import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { getSubscriber, hasAccess } from "@/lib/subscriptions";
import { growthSeries, type GrowthPeriod } from "@/lib/provider-insights";

export const dynamic = "force-dynamic";
const PERIODS = new Set(["day", "week", "month", "quarter", "year"]);

/** Growth series for the chart — retroactive new-store launches + forward churn.
 *  Paid-gated (proprietary). Params: period, country, provider, from, to (YYYY-MM-DD). */
export async function GET(req: Request) {
  const email = await currentUser();
  if (!email) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const subscriber = await getSubscriber(email).catch(() => null);
  if (!hasAccess(subscriber) && !isAdmin(email)) return NextResponse.json({ error: "No access" }, { status: 403 });

  const p = new URL(req.url).searchParams;
  const period = (PERIODS.has(p.get("period") ?? "") ? p.get("period") : "month") as GrowthPeriod;
  const data = await growthSeries({
    period,
    country: p.get("country") || undefined,
    provider: p.get("provider") || undefined,
    from: p.get("from") || undefined,
    to: p.get("to") || undefined,
  }).catch(() => null);
  if (!data) return NextResponse.json({ error: "failed" }, { status: 500 });
  return NextResponse.json(data);
}
