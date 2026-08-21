/** Admin: manage outreach connections — connect (verify + store encrypted key),
 *  update config (target campaign), disconnect. Owner-only. */

import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import {
  setConnection, updateConfig, deleteConnection, verifyKey, listCampaigns,
  type ProviderKey,
} from "@/lib/integrations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVIDERS: ProviderKey[] = ["instantly", "smartlead"];

export async function POST(req: Request) {
  const email = await currentUser();
  if (!isAdmin(email)) return NextResponse.json({ error: "Not authorised" }, { status: 403 });

  let body: { action?: string; provider?: string; apiKey?: string; config?: Record<string, unknown> };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const provider = body.provider as ProviderKey;
  if (!PROVIDERS.includes(provider)) return NextResponse.json({ error: "unknown provider" }, { status: 400 });

  try {
    if (body.action === "disconnect") {
      await deleteConnection(email!, provider);
      return NextResponse.json({ ok: true });
    }
    if (body.action === "config") {
      await updateConfig(email!, provider, body.config ?? {});
      return NextResponse.json({ ok: true });
    }
    if (body.action === "campaigns") {
      const campaigns = await listCampaigns(email!, provider);
      return NextResponse.json({ ok: true, campaigns });
    }
    // connect: verify the key by listing campaigns, then store it.
    const apiKey = (body.apiKey ?? "").trim();
    if (!apiKey) return NextResponse.json({ error: "API key required" }, { status: 400 });
    const campaigns = await verifyKey(provider, apiKey);
    await setConnection(email!, provider, apiKey, body.config ?? {});
    return NextResponse.json({ ok: true, campaigns });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
