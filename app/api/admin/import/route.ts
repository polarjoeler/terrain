/** Admin: upload a CSV of stores into the pending "base" pool. Owner-only. */

import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { importCsv } from "@/lib/imported";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!isAdmin(await currentUser())) {
    return NextResponse.json({ error: "Not authorised" }, { status: 403 });
  }
  const text = await req.text();
  if (!text.trim()) {
    return NextResponse.json({ error: "Empty file" }, { status: 400 });
  }
  try {
    const result = await importCsv(text);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Import failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
