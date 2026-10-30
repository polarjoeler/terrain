/** Admin subscriber management — grant/extend a trial, activate, cancel, or
 *  change plan. Owner/admin only. */

import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { applyAdminAction, type SubscriberAction } from "@/lib/subscriptions";
import { PLANS } from "@/lib/plans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SIMPLE_ACTIONS = ["trial", "activate", "cancel"] as const;

/** Accepts the three simple actions plus setPlan:<planKey>, validating the key against
 *  PLANS so an unknown tier is rejected rather than silently resolved. */
function parseAction(raw: string | undefined): SubscriberAction | null {
  if (!raw) return null;
  if ((SIMPLE_ACTIONS as readonly string[]).includes(raw)) return raw as SubscriberAction;
  if (raw.startsWith("setPlan:") && raw.slice(8) in PLANS) return raw as SubscriberAction;
  return null;
}

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
  const action = parseAction(body.action);
  if (!target || !action) {
    return NextResponse.json({ error: "email and a valid action are required" }, { status: 400 });
  }
  const updated = await applyAdminAction(target, action);
  return NextResponse.json({ ok: true, subscriber: updated });
}
