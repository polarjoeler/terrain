/** Admin: add/remove a tag (Top 100, Partner Managed, …) across one or more
 *  stores. Owner-only. POST { domains: string[], tag: string, on: boolean } */

import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { setTag } from "@/lib/tags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isAdmin(await currentUser())) {
    return NextResponse.json({ error: "Not authorised" }, { status: 403 });
  }
  let body: { domains?: string[]; tag?: string; on?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const domains = (body.domains ?? []).filter(Boolean);
  const tag = (body.tag ?? "").trim().toLowerCase().replace(/\s+/g, "-");
  if (!domains.length || !tag) {
    return NextResponse.json({ error: "domains and tag are required" }, { status: 400 });
  }
  const n = await setTag(domains, tag, body.on !== false);
  return NextResponse.json({ ok: true, affected: n, tag, on: body.on !== false });
}
