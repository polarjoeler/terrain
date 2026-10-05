import { NextResponse } from "next/server";
import { refreshBrowseCache } from "@/lib/browse";
import { availableCountries } from "@/lib/insights";
import { cachedAgg } from "@/lib/agg-cache";
import { africaTimeline } from "@/lib/africa-timeline";

// Warms the durable leads-browse aggregate cache (browse_cache) for the hot keys — the unfiltered
// default + each market — so cold page loads read a precomputed counts/facets result instead of
// running the 3–30s live scan on the busy pooler. Trigger from a scheduler (Vercel Cron sends
// `Authorization: Bearer $CRON_SECRET`, or pass ?token=); if CRON_SECRET is unset the route is open
// (fine for manual warming + the fleet launchd curl). The scan is heavy — allow up to 60s.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const token = new URL(req.url).searchParams.get("token");
    if (req.headers.get("authorization") !== `Bearer ${secret}` && token !== secret) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
  }
  const t = Date.now();
  const warmed = await refreshBrowseCache().catch(() => -1);
  // Also warm the insights country-picker counts (a ~8s focus-market GROUP BY) off the request path,
  // so the picker never pays it on a user load — best-effort, never fails the warm.
  const countries = await availableCountries().then((c) => c.length).catch(() => -1);
  // Warm the public landing-page aggregate (home + /africa) so those force-dynamic pages serve real
  // data, not the 4s-timeout empty state. refresh:true forces a fresh compute into the durable row.
  const africa = await cachedAgg("africa:timeline:v3", 0, africaTimeline).then(() => true).catch(() => false);
  return NextResponse.json({ ok: warmed >= 0, warmed, countries, africa, ms: Date.now() - t });
}
