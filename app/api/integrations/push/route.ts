/** Push a cohort of contactable leads to a connected outreach tool.
 *
 *  A push is an EXPORT — it hands the customer the most valuable column we hold, in bulk, to a
 *  destination we don't control. It was previously admin-only and so gated on nothing else, which
 *  made it the "third place to forget" that lib/export-gate warns about: no row allowance, no plan
 *  platform ceiling, no anti-sharing check. Un-gating the panel without this would have made a
 *  push the cheapest way around the pricing ladder — a $69 Leads seat with a 500-row CSV cap could
 *  move the whole contactable base into its own sender in one click.
 *
 *  So it now goes through the same gate as CSV, with one ordering difference argued in
 *  lib/export-gate's header: the query is CLAMPED to the rows left this month, and the charge is
 *  taken AFTER delivery for what the provider actually accepted. A customer is never billed for
 *  leads a half-failed push never sent.
 *
 *  POST { provider, campaignId, country?, quality?, limit?, tag? }  — tag is admin-only.
 */

import { NextResponse } from "next/server";
import { chargeExport, openExport, remainingAllowance } from "@/lib/export-gate";
import { maxPerPush, pushLeads, PROVIDERS, type ProviderKey } from "@/lib/integrations";
import { outreachCounts, outreachLeads, type OutreachQuality } from "@/lib/imported";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const KNOWN = new Set<string>(PROVIDERS.map((p) => p.key));

export async function POST(req: Request) {
  const gate = await openExport();
  if (!gate.ok) return gate.response;
  const { email, admin, scope } = gate;

  let body: {
    provider?: string; campaignId?: string; tag?: string; country?: string;
    quality?: string; limit?: number;
  };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const provider = body.provider as ProviderKey;
  const campaignId = (body.campaignId ?? "").trim();
  if (!KNOWN.has(provider) || !campaignId) {
    return NextResponse.json({ error: "provider and campaignId required" }, { status: 400 });
  }

  // Cohort tags are our internal curation vocabulary (top-500, foreign-storefront, …), so a
  // customer selects by country and quality; only an admin picks a tag.
  const tag = admin ? body.tag : undefined;
  const quality: OutreachQuality = body.quality === "all" ? "all" : "reachable";

  // Delivery ceiling (provider) ∩ what's left this month (plan) ∩ what was asked for.
  const remaining = await remainingAllowance(email, admin);
  if (remaining === 0) {
    return NextResponse.json(
      { error: "No export rows left on your plan this month.", remaining: 0, quota: true },
      { status: 403 },
    );
  }
  const asked = Number.isFinite(body.limit) ? Math.max(1, Math.floor(body.limit!)) : Infinity;
  const cap = Math.min(maxPerPush(provider), asked, remaining ?? Infinity);

  const select = { country: body.country, tag, platforms: scope };
  const [leads, counts] = await Promise.all([
    outreachLeads({ ...select, quality, limit: cap }),
    outreachCounts(select),
  ]);

  const matched = quality === "reachable" ? counts.reachable : counts.all;
  if (!leads.length) {
    return NextResponse.json({
      ok: true, pushed: 0, matched, reachable: counts.reachable, contactable: counts.all,
      note: quality === "reachable" && counts.all > 0
        ? `None of the ${counts.all.toLocaleString()} contactable stores in that cohort reach a person. Widen to all contacts to send to generic mailboxes.`
        : "No contactable leads in that cohort.",
    });
  }

  let pushed = 0;
  let pushError: string | undefined;
  try {
    const result = await pushLeads(email, provider, campaignId, leads);
    pushed = result.pushed;
    pushError = result.error;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Push failed" },
      { status: 400 },
    );
  }

  // Charge what landed. The clamp above means this cannot exceed the allowance, so a failure here
  // is a billing-side problem and must not be reported as a failed push — the leads are already
  // in the customer's tool and cannot be recalled.
  let charge: { remaining: number | null; limit: number | null } | null = null;
  if (pushed > 0) {
    const charged = await chargeExport(email, admin, pushed);
    if (charged.ok) charge = { remaining: charged.remaining, limit: charged.limit };
    else console.error(`[integrations] push delivered ${pushed} but quota charge failed for ${email}`);
  }

  return NextResponse.json({
    ok: true,
    pushed,
    sent: leads.length,
    matched,
    reachable: counts.reachable,
    contactable: counts.all,
    truncated: matched > leads.length ? { cap, matched } : undefined,
    remaining: charge?.remaining ?? null,
    limit: charge?.limit ?? null,
    error: pushError,
  });
}
