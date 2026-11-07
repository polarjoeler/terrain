import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { fleetActivity } from "@/lib/fleet";

export const dynamic = "force-dynamic";

/** Machine-attributed live activity feed for /fleet. Admin-only (internal ops). Served from the
 *  fleet module's short cache, so frequent polling is cheap. */
export async function GET() {
  const email = await currentUser();
  if (!isAdmin(email)) return NextResponse.json({ error: "No access" }, { status: 403 });
  const events = await fleetActivity(40).catch(() => []);
  return NextResponse.json({ events });
}
