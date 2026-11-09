/** Manage outreach connections — connect (verify + store encrypted key), pick a target campaign,
 *  disconnect. Was admin-only; now serves the customer Connections panel too.
 *
 *  Gated on ACCESS, not on a paid plan, deliberately: connecting reveals nothing and sends nothing,
 *  so a trialling account can wire up Instantly or HubSpot during the trial and have it ready. The
 *  door that hands over data is the push, and that one goes through lib/export-gate — which refuses
 *  a trial. Keep the asymmetry: loosening it here is safe, loosening it there is not.
 *
 *  A connection belongs to the org (lib/integrations funnels every owner through orgKey), so a
 *  seat holder connecting Slack and the payer revoking it are acting on the same row.
 */

import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { getSubscriber, hasAccess } from "@/lib/subscriptions";
import {
  setConnection, updateConfig, deleteConnection, verifyKey, listCampaigns,
  PROVIDERS, type ProviderKey,
} from "@/lib/integrations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED = new Set<string>(PROVIDERS.map((p) => p.key));

export async function POST(req: Request) {
  const email = await currentUser();
  if (!email) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(email)) {
    const sub = await getSubscriber(email).catch(() => null);
    if (!hasAccess(sub)) return NextResponse.json({ error: "no_access" }, { status: 403 });
  }

  let body: { action?: string; provider?: string; apiKey?: string; config?: Record<string, unknown> };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const provider = body.provider as ProviderKey;
  if (!ALLOWED.has(provider)) return NextResponse.json({ error: "unknown provider" }, { status: 400 });

  try {
    if (body.action === "disconnect") {
      await deleteConnection(email, provider);
      return NextResponse.json({ ok: true });
    }
    if (body.action === "config") {
      await updateConfig(email, provider, body.config ?? {});
      return NextResponse.json({ ok: true });
    }
    if (body.action === "campaigns") {
      const campaigns = await listCampaigns(email, provider);
      return NextResponse.json({ ok: true, campaigns });
    }
    // connect: verify the key by listing campaigns, then store it.
    const apiKey = (body.apiKey ?? "").trim();
    if (!apiKey) return NextResponse.json({ error: "API key required" }, { status: 400 });
    const campaigns = await verifyKey(provider, apiKey, body.config ?? {});
    await setConnection(email, provider, apiKey, body.config ?? {});
    return NextResponse.json({ ok: true, campaigns });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
