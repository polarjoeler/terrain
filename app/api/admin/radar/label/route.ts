/** Admin: label a suppressed store pair as fraud / commerce / same-owner, so the
 *  clone scoring can be tuned against real judgements. Owner-only.
 *  POST { victim, suspect, label }  — label null clears it. */

import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { cleanDomain } from "@/lib/radar/catalog";
import { setLabel, type RelationshipLabel } from "@/lib/radar/relationships";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID: RelationshipLabel[] = ["fraud", "commerce", "same-owner"];

export async function POST(req: Request) {
  if (!isAdmin(await currentUser())) return NextResponse.json({ error: "Not authorised" }, { status: 403 });
  let body: { victim?: string; suspect?: string; label?: string | null };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const victim = cleanDomain(body.victim ?? "");
  const suspect = cleanDomain(body.suspect ?? "");
  if (!victim || !suspect) return NextResponse.json({ error: "victim and suspect required" }, { status: 400 });

  const label = body.label == null ? null : (body.label as RelationshipLabel);
  if (label !== null && !VALID.includes(label))
    return NextResponse.json({ error: `label must be one of ${VALID.join(", ")} or null` }, { status: 400 });

  const ok = await setLabel(victim, suspect, label);
  return NextResponse.json({ ok, updated: ok ? 1 : 0 });
}
