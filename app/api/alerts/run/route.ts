/** Scheduled market-event alerts to connected channels (today: Slack).
 *
 *  For each org with the provider connected: take the events in its focus it hasn't been told
 *  about, cap them, post, and only then record delivery — a failed post retries next run.
 *
 *  SAFE BY DEFAULT — nothing is posted unless ALERTS_ENABLED=1. Otherwise it runs as a dry-run
 *  (selects, renders, reports, sends nothing, records nothing), the same contract as
 *  /api/digest/send. Wire an hourly cron to POST here once the churn lane is producing again.
 *
 *  Auth: header `x-cron-secret: $CRON_SECRET`, or an admin session for manual testing.
 *
 *  Alerts are NOT metered against the export allowance: an event is a notification about a store,
 *  not a bulk handover of contact data. The lead-push path is the metered one (lib/export-gate).
 */
import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import {
  DEFAULT_WINDOW_DAYS, MAX_PER_RUN, markSent, recentEvents, slackMessage, unsentFor,
} from "@/lib/alerts";
import { listConnectionOwners, notify } from "@/lib/integrations";
import { orgFocus } from "@/lib/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function authorised(req: Request): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("x-cron-secret") === secret) return true;
  return isAdmin(await currentUser());
}

export async function POST(req: Request) {
  if (!(await authorised(req))) return NextResponse.json({ error: "unauthorised" }, { status: 401 });

  const enabled = process.env.ALERTS_ENABLED === "1";
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? new URL(req.url).origin;
  const windowDays = Number(new URL(req.url).searchParams.get("days")) || DEFAULT_WINDOW_DAYS;

  const events = await recentEvents({ windowDays });
  const owners = await listConnectionOwners("slack");

  let posted = 0, skippedEmpty = 0, failed = 0;
  const detail: { org: string; events: number; sent: number; error?: string }[] = [];

  for (const org of owners) {
    // Sequential, not Promise.all — the pool is small (see lib/profile.dueDigestUsers).
    const focus = await orgFocus(org);
    const pending = await unsentFor(org, focus, events);
    if (!pending.length) { skippedEmpty++; detail.push({ org, events: 0, sent: 0 }); continue; }

    const batch = pending.slice(0, MAX_PER_RUN);
    const msg = slackMessage(batch, { siteUrl, truncatedFrom: pending.length });
    if (!enabled) { detail.push({ org, events: pending.length, sent: 0 }); continue; }
    try {
      await notify(org, "slack", msg);
      await markSent(org, batch);
      posted++;
      detail.push({ org, events: pending.length, sent: batch.length });
    } catch (err) {
      failed++;
      detail.push({ org, events: pending.length, sent: 0, error: err instanceof Error ? err.message : "post failed" });
    }
  }

  return NextResponse.json({
    ok: true,
    mode: enabled ? "live" : "dry-run",
    windowDays,
    candidates: events.length,
    channels: owners.length,
    posted, skippedEmpty, failed,
    detail,
    // Surfaced so a run that sends nothing is diagnosable: an empty window with channels
    // connected means the churn lane, not the alert lane, is the thing that stopped.
    note: events.length === 0
      ? `No forward churn detected in the last ${windowDays} days — check that scripts/verify-liveness.mjs is still running (it is step 7/7 of radar-pipeline.sh and its failure is swallowed by \`|| echo\`).`
      : undefined,
  });
}

/** Admin preview: exactly what the next run would post, without posting it. `org` defaults to the
 *  caller's own, `days` widens the window — both so a stalled source can still be rehearsed
 *  against historical events. */
export async function GET(req: Request) {
  const email = await currentUser();
  if (!isAdmin(email)) return NextResponse.json({ error: "unauthorised" }, { status: 401 });

  const url = new URL(req.url);
  const org = url.searchParams.get("org") ?? email!;
  const windowDays = Number(url.searchParams.get("days")) || DEFAULT_WINDOW_DAYS;
  const ignoreSent = url.searchParams.get("fresh") === "1";

  const events = await recentEvents({ windowDays });
  const focus = await orgFocus(org);
  // `fresh=1` rehearses as if nothing had been sent — the focus filter still applies, since that
  // is the part worth inspecting. An org key no row can match gives exactly that, and reads only.
  const against = ignoreSent ? `__preview__${org}` : org;
  const inScope = await unsentFor(against, focus, events);

  const batch = inScope.slice(0, MAX_PER_RUN);
  return NextResponse.json({
    ok: true,
    org,
    windowDays,
    focus,
    candidates: events.length,
    inFocus: inScope.length,
    message: batch.length
      ? slackMessage(batch, { siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? url.origin, truncatedFrom: inScope.length })
      : null,
  });
}
