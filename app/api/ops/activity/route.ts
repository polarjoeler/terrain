import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { recentActivity } from "@/lib/ops";

// Live activity feed for the /ops dashboard — polled every few seconds by the client. Admin-only,
// same gate as /ops. Never cached (it's a real-time snapshot of what the swarm just touched).
export const dynamic = "force-dynamic";

export async function GET() {
  const email = await currentUser();
  if (!email || !isAdmin(email)) return NextResponse.json({ events: [] }, { status: 403 });
  const events = await recentActivity(60).catch(() => []);
  return NextResponse.json({ events });
}
