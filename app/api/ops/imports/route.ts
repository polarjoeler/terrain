/** Imports progress — per-source enrichment status for recently imported batches.
 *  Admin only. On-demand (called from /ops on a button press), never on the auto-refresh, so a
 *  heavier GROUP BY never slows the dashboard. Scoped to a recent window via ?days=. */

import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { importsProgress } from "@/lib/ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // the cold GROUP BY can take ~15-25s; cached after that

export async function GET(req: Request) {
  const email = await currentUser();
  if (!isAdmin(email)) return NextResponse.json({ error: "Not authorised" }, { status: 403 });

  const url = new URL(req.url);
  const days = Number(url.searchParams.get("days") ?? "30");
  const fresh = url.searchParams.get("fresh") === "1";
  const report = await importsProgress(Number.isFinite(days) ? days : 30, fresh);
  return NextResponse.json({ ok: true, ...report });
}
