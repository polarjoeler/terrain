/** Scheduled per-user weekly digest send. Iterates the users whose digest is DUE (opted in +
 *  cadence elapsed), builds a digest scoped to each user's platform focus, and emails it.
 *
 *  SAFE BY DEFAULT — nothing goes out until DIGEST_ENABLED=1 AND RESEND_API_KEY are both set;
 *  otherwise it runs as a dry-run (builds + reports, sends nothing, doesn't mark users sent).
 *
 *  Auth: header `x-cron-secret: $CRON_SECRET` (for the scheduled caller), or an admin session
 *  (for manual testing). Wire a daily cron to POST here.
 */
import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { buildDigest } from "@/lib/digest";
import { publishedLeads } from "@/lib/imported";
import { digestSnapshot } from "@/lib/insights";
import { sendEmail } from "@/lib/email";
import { dueDigestUsers, markDigestSent } from "@/lib/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CMS = new Set(["shopify", "woocommerce", "magento", "wix"]);

async function authorised(req: Request): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("x-cron-secret") === secret) return true;
  return isAdmin(await currentUser());
}

export async function POST(req: Request) {
  if (!(await authorised(req))) return NextResponse.json({ error: "unauthorised" }, { status: 401 });

  const enabled = process.env.DIGEST_ENABLED === "1" && !!process.env.RESEND_API_KEY;
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? new URL(req.url).origin;
  const due = await dueDigestUsers();

  // Share the market snapshot across users; leads are re-fetched per platform focus (cached by pg).
  const insights = await digestSnapshot().catch(() => null);
  const leadCache = new Map<string, Awaited<ReturnType<typeof publishedLeads>>>();
  const leadsFor = async (platform?: string) => {
    const k = platform ?? "all";
    if (!leadCache.has(k)) leadCache.set(k, await publishedLeads(undefined, platform));
    return leadCache.get(k)!;
  };

  let sent = 0, skippedEmpty = 0, failed = 0;
  for (const u of due) {
    // Scope to the first specific CMS the user asked for (else the whole market).
    const focus = u.leadFocus.find((f) => CMS.has(f.toLowerCase()))?.toLowerCase();
    const leads = await leadsFor(focus);
    if (!leads.length) { skippedEmpty++; continue; }
    const { subject, html, text } = buildDigest({ leads, insights, siteUrl });
    if (!enabled) continue;  // dry-run: built but not sent, user not marked
    try {
      await sendEmail({ to: u.email, subject, html, text });
      await markDigestSent(u.email);
      sent++;
    } catch { failed++; }
  }

  return NextResponse.json({
    ok: true, mode: enabled ? "live" : "dry-run",
    due: due.length, sent, skippedEmpty, failed,
    note: enabled ? undefined : "Set DIGEST_ENABLED=1 and RESEND_API_KEY to actually send.",
  });
}
