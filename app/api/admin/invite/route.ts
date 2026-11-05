/** Mint an admin sign-up link for one email address.
 *
 *  WHY A TOKEN AND NOT A ROW: the plan and trial length travel inside the signed token, so this
 *  route writes nothing. Creating a link has no effect until someone opens it, and the trial clock
 *  starts on redemption rather than on generation — so a link made on Monday and opened on Friday
 *  still gives its full term.
 *
 *  SECURITY SHAPE, stated plainly because this hands out paid access:
 *   · admin-only, same isAdmin() gate as every other /api/admin route;
 *   · the token authenticates as the address baked into it, so it is only as safe as the channel
 *     you send it over — treat it like a password reset link, not a marketing URL;
 *   · single-use (the jti is burned on redemption) and expires in 7 days;
 *   · it CANNOT be revoked once sent, because there is no row to delete. If one goes to the wrong
 *     person, cancel that subscriber in /admin/subscribers — that removes the access the link grants.
 */

import { NextResponse } from "next/server";
import { createInviteToken, currentUser, isAdmin, originFromRequest } from "@/lib/auth";
import { PLANS } from "@/lib/plans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_DAYS = 90;

export async function POST(req: Request) {
  const admin = await currentUser();
  if (!isAdmin(admin)) return NextResponse.json({ error: "Not authorised" }, { status: 403 });

  let body: { email?: string; plan?: string; days?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const email = (body.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
  }
  // Validate against PLANS rather than resolvePlan: an unknown tier must be REJECTED here, not
  // silently resolved to Leads, or a typo would quietly hand out the wrong plan.
  const plan = body.plan ?? "";
  if (!(plan in PLANS)) {
    return NextResponse.json({ error: `Unknown plan '${plan}'` }, { status: 400 });
  }
  const days = Math.floor(Number(body.days));
  if (!Number.isFinite(days) || days < 1 || days > MAX_DAYS) {
    return NextResponse.json({ error: `Days must be between 1 and ${MAX_DAYS}` }, { status: 400 });
  }

  const token = createInviteToken(email, plan, days);
  const url = `${originFromRequest(req)}/api/auth/verify?token=${encodeURIComponent(token)}`;

  // No invites table, so the server log is the only audit trail of who handed out what.
  console.log(`[terrain] invite minted by ${admin} for ${email}: ${plan}, ${days}d`);

  return NextResponse.json({ ok: true, url, email, plan, days });
}
