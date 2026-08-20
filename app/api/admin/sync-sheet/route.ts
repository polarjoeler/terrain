/** Sync the cert-transparency discovery feed (Sheet) into Postgres — backfills
 *  discovered_at / first_product_at and imports fresh ZA finds. Triggered from
 *  the Mac pipeline (Bearer CRON_SECRET) or manually by an admin. */

import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { syncFromSheet } from "@/lib/imported";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function authorized(req: Request, email: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") === `Bearer ${secret}`) return true;
  return isAdmin(email);
}

async function run(req: Request) {
  const email = await currentUser();
  if (!authorized(req, email)) {
    return NextResponse.json({ error: "Not authorised" }, { status: 403 });
  }
  const result = await syncFromSheet();
  return NextResponse.json(result);
}

// GET so the cron can trigger it with a simple curl; POST for form/manual use.
export const GET = run;
export const POST = run;
