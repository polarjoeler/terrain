/** Admin: given a list of domains (from a screenshot/CSV extraction), report
 *  which are already in the DB — so you can see how many are genuinely new
 *  before importing. Owner-only. POST { domains: string[] } */

import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { existingDomains } from "@/lib/imported";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isAdmin(await currentUser())) {
    return NextResponse.json({ error: "Not authorised" }, { status: 403 });
  }
  let body: { domains?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const existing = await existingDomains(body.domains ?? []);
  return NextResponse.json({ ok: true, existing });
}
