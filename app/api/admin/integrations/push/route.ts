/** Admin: push a cohort of contactable leads to a connected outreach tool's
 *  campaign. Owner-only. POST { provider, campaignId, tag?, country? } */

import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { pushLeads, type ProviderKey } from "@/lib/integrations";
import { outreachLeads } from "@/lib/imported";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const email = await currentUser();
  if (!isAdmin(email)) return NextResponse.json({ error: "Not authorised" }, { status: 403 });

  let body: { provider?: string; campaignId?: string; tag?: string; country?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const provider = body.provider as ProviderKey;
  const campaignId = (body.campaignId ?? "").trim();
  if (!provider || !campaignId) return NextResponse.json({ error: "provider and campaignId required" }, { status: 400 });

  const leads = await outreachLeads({ country: body.country, tag: body.tag });
  if (!leads.length) return NextResponse.json({ ok: true, pushed: 0, total: 0, note: "No contactable leads in that cohort." });

  try {
    const result = await pushLeads(email!, provider, campaignId, leads);
    return NextResponse.json({ ok: true, total: leads.length, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Push failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
