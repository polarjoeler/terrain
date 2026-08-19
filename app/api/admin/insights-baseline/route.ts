/** Reset the Insights baseline — call after a bulk import so the batch lands as
 *  a level-shift instead of skewing growth/forward-churn. Owner-only. */

import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { computeInsights, snapshotInsights, setBaselineDate, getBaselineDate } from "@/lib/insights";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!isAdmin(await currentUser())) {
    return NextResponse.json({ error: "Not authorised" }, { status: 403 });
  }
  return NextResponse.json({ baseline: await getBaselineDate() });
}

export async function POST() {
  if (!isAdmin(await currentUser())) {
    return NextResponse.json({ error: "Not authorised" }, { status: 403 });
  }
  try {
    // Ensure today's snapshot exists, then anchor the baseline to it.
    const data = await computeInsights();
    await snapshotInsights(data);
    await setBaselineDate(data.date);
    return NextResponse.json({ ok: true, baseline: data.date });
  } catch (err) {
    console.error("baseline reset failed", err);
    return NextResponse.json({ error: "Reset failed" }, { status: 500 });
  }
}
