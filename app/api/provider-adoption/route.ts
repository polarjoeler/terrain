import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { getSubscriber, hasAccess } from "@/lib/subscriptions";
import { providerAdoptionSeries, type PlatformSel } from "@/lib/insights";
import { cachedAgg } from "@/lib/agg-cache";

export const dynamic = "force-dynamic";
const PLATFORMS = new Set(["all", "shopify", "woocommerce", "magento"]);

/** 10-year provider adoption curve (cumulative installed base by launch year — best estimate of
 *  when each live store chose its provider). Paid-gated. Params: country, platform. */
export async function GET(req: Request) {
  const email = await currentUser();
  if (!email) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const subscriber = await getSubscriber(email).catch(() => null);
  if (!hasAccess(subscriber) && !isAdmin(email)) return NextResponse.json({ error: "No access" }, { status: 403 });

  const p = new URL(req.url).searchParams;
  const country = (p.get("country") || "ZA").toUpperCase();
  const platform = (PLATFORMS.has(p.get("platform") ?? "") ? p.get("platform") : "all") as PlatformSel;

  // Viewer-agnostic + heavy-ish (scans the market's live base) → share one cached row for 30 min.
  const data = await cachedAgg(
    `insights:adoption:${country}:${platform}:v1`,
    30 * 60 * 1000,
    () => providerAdoptionSeries(country, platform),
  ).catch(() => null);
  if (!data) return NextResponse.json({ error: "failed" }, { status: 500 });
  return NextResponse.json(data);
}
