/** Admin: dismiss a fraud detection (a same-owner false positive, say) so the
 *  Market Fraud view hides it and the sweep never resurfaces it. Owner-only.
 *  POST { victim, suspect? , dismissed? }  — omit suspect to dismiss the whole
 *  cluster (all clones of that victim). */

import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { db, ensureSchema } from "@/lib/radar/db";
import { cleanDomain } from "@/lib/radar/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isAdmin(await currentUser())) {
    return NextResponse.json({ error: "Not authorised" }, { status: 403 });
  }
  let body: { victim?: string; suspect?: string; dismissed?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const victim = cleanDomain(body.victim ?? "");
  if (!victim) return NextResponse.json({ error: "victim required" }, { status: 400 });
  const dismissed = body.dismissed !== false; // default true
  const suspect = body.suspect ? cleanDomain(body.suspect) : null;

  await ensureSchema();
  const rows = suspect
    ? await db()`UPDATE radar_detections SET dismissed = ${dismissed}
        WHERE source = 'fraud' AND brand_domain = ${victim} AND suspect = ${suspect} RETURNING suspect`
    : await db()`UPDATE radar_detections SET dismissed = ${dismissed}
        WHERE source = 'fraud' AND brand_domain = ${victim} RETURNING suspect`;
  return NextResponse.json({ ok: true, updated: rows.length });
}
