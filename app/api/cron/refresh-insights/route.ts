import { NextResponse } from "next/server";
import { refreshInsightsCache } from "@/lib/insights";

// Warms the shared Insights cache (recomputes every market × platform view into insights_cache) so
// page reads are always the fast cached path. Trigger from a scheduler (Vercel Cron sends
// `Authorization: Bearer $CRON_SECRET`, or pass ?token=). If CRON_SECRET is unset the route is open
// (fine for manual warming). Computing all combos takes a bit — allow up to 60s.
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
  const refreshed = await refreshInsightsCache().catch(() => -1);
  return NextResponse.json({ ok: refreshed >= 0, refreshed, ms: Date.now() - t });
}
