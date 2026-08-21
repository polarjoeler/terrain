/** Admin: run the market fraud sweep on-demand and record the run. Owner-only.
 *  Compute-heavy but bounded (in-memory over the fingerprints). */

import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { runFraudSweep } from "@/lib/radar/fraud-sweep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST() {
  if (!isAdmin(await currentUser())) {
    return NextResponse.json({ error: "Not authorised" }, { status: 403 });
  }
  try {
    const result = await runFraudSweep();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Sweep failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
