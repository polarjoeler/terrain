/** Admin subscriber management — grant/extend a trial, activate, cancel, or
 *  change plan. Owner/admin only. */

import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { applyAdminAction, type SubscriberAction } from "@/lib/subscriptions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS: SubscriberAction[] = ["trial", "activate", "cancel", "makePro", "makeStarter"];

export async function POST(req: Request) {
  const email = await currentUser();
  if (!isAdmin(email)) {
    return NextResponse.json({ error: "Not authorised" }, { status: 403 });
  }
  let body: { email?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const target = (body.email ?? "").trim().toLowerCase();
  const action = body.action as SubscriberAction;
  if (!target || !ACTIONS.includes(action)) {
    return NextResponse.json({ error: "email and a valid action are required" }, { status: 400 });
  }
  const updated = await applyAdminAction(target, action);
  return NextResponse.json({ ok: true, subscriber: updated });
}
