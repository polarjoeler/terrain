/** Admin: publish (or discard) the pending imported base. Owner-only. */

import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { clearPending, publishPending } from "@/lib/imported";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!isAdmin(await currentUser())) {
    return NextResponse.json({ error: "Not authorised" }, { status: 403 });
  }
  const { action, domains } = (await req.json().catch(() => ({}))) as {
    action?: string;
    domains?: string[];
  };
  const only = Array.isArray(domains) && domains.length ? domains : undefined;
  try {
    if (action === "discard") {
      const n = await clearPending(only);
      return NextResponse.json({ ok: true, discarded: n });
    }
    const n = await publishPending(only);
    return NextResponse.json({ ok: true, published: n });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
