/** Admin: fingerprint the store universe for Radar audits. Owner-only.
 *
 *  GET  -> current coverage.
 *  POST -> enrich the next batch (call repeatedly until remaining is 0).
 */

import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { coverage, enrichBatch } from "@/lib/radar/fingerprints";
import type { Market } from "@/lib/prioritize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BATCH = 20;

export async function GET() {
  if (!isAdmin(await currentUser())) {
    return NextResponse.json({ error: "Not authorised" }, { status: 403 });
  }
  return NextResponse.json({ coverage: await coverage("South Africa") });
}

export async function POST(req: Request) {
  if (!isAdmin(await currentUser())) {
    return NextResponse.json({ error: "Not authorised" }, { status: 403 });
  }
  const market = (new URL(req.url).searchParams.get("market") as Market) || "South Africa";
  try {
    const result = await enrichBatch(market, BATCH);
    return NextResponse.json(result);
  } catch (err) {
    console.error("enrich failed", err);
    return NextResponse.json({ error: "Enrichment failed" }, { status: 500 });
  }
}
