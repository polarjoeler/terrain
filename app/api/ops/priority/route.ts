/** Project priority cue — read/update the single "what matters most right now" knob.
 *  Admin only. GET returns the current priority; POST sets it. Persisted in app_settings. */

import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { getOpsPriority, setOpsPriority, type OpsPriorityMode } from "@/lib/ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODES: OpsPriorityMode[] = ["balanced", "import", "country"];

export async function GET() {
  const email = await currentUser();
  if (!isAdmin(email)) return NextResponse.json({ error: "Not authorised" }, { status: 403 });
  return NextResponse.json({ ok: true, priority: await getOpsPriority() });
}

export async function POST(req: Request) {
  const email = await currentUser();
  if (!isAdmin(email)) return NextResponse.json({ error: "Not authorised" }, { status: 403 });

  let body: { mode?: string; country?: string | null; note?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const mode = body.mode as OpsPriorityMode;
  if (!MODES.includes(mode)) return NextResponse.json({ error: "invalid mode" }, { status: 400 });
  if (mode === "country" && !(body.country ?? "").trim()) {
    return NextResponse.json({ error: "country required for country mode" }, { status: 400 });
  }
  const priority = await setOpsPriority({ mode, country: body.country ?? null, note: body.note ?? "" }, email);
  return NextResponse.json({ ok: true, priority });
}
