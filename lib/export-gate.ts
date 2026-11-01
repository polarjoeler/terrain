/** One gate for every export surface.
 *
 *  Exports used to be gated in each route, which is how /api/explore-export shipped with the
 *  anti-sharing check but no quota and no platform ceiling, while the metered copy sat in an
 *  /api/export nothing called. Any new export surface should call these two functions and
 *  nothing else — there is no third place to forget.
 *
 *  Two stages, because the row count isn't known until the query runs:
 *    openExport()   — identity, access, sharing gate, platform ceiling  (before the query)
 *    chargeExport() — reserve the rows against the monthly quota        (after the count)
 *  Charging after the count means a customer is never billed rows the filter didn't return.
 */
import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { consumeExportQuota, getSubscriber, hasAccess } from "@/lib/subscriptions";
import { platformsFor } from "@/lib/plans";
import { sharingGate } from "@/lib/sessions";
import type { BrowseFilters } from "@/lib/browse";

type Denied = { ok: false; response: NextResponse };
type Opened = { ok: true; email: string; admin: boolean; scope: string[] | null };

/** Access + anti-sharing + the plan's platform ceiling. Admins export unscoped. */
export async function openExport(): Promise<Denied | Opened> {
  const email = await currentUser();
  if (!email) {
    return { ok: false, response: NextResponse.json({ error: "Not signed in" }, { status: 401 }) };
  }

  const admin = isAdmin(email);
  let scope: string[] | null = null;
  if (!admin) {
    const sub = await getSubscriber(email).catch(() => null);
    if (!hasAccess(sub)) {
      return { ok: false, response: NextResponse.json({ error: "no_access" }, { status: 403 }) };
    }
    scope = platformsFor(sub?.plan);
  }

  // Anti-sharing: block bulk export when the seat is signed in from too many devices at once
  // (the classic shared-login signal). Browsing stays open; only exfiltration is gated.
  const gate = await sharingGate(email);
  if (!gate.ok) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `This account is signed in from ${gate.ips} locations (limit ${gate.cap}). Sign out other devices, or contact us to add seats.`, sharing: true },
        { status: 403 },
      ),
    };
  }

  return { ok: true, email, admin, scope };
}

/** Apply the plan's platform ceiling to whatever the client asked for. `planPlatforms` is
 *  intersected with any client `platform` filter in buildWhere, so this can only narrow. */
export const scopeFilters = (f: BrowseFilters, scope: string[] | null): BrowseFilters =>
  scope ? { ...f, planPlatforms: scope } : f;

/** Reserve `rows` against the monthly allowance. Unmetered plans are counted, never refused. */
export async function chargeExport(
  email: string,
  admin: boolean,
  rows: number,
): Promise<Denied | { ok: true; remaining: number | null; limit: number | null }> {
  if (admin) return { ok: true, remaining: null, limit: null };
  const quota = await consumeExportQuota(email, rows);
  if (!quota.ok) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: quota.reason, remaining: quota.remaining, limit: quota.limit, quota: true },
        { status: 403 },
      ),
    };
  }
  return { ok: true, remaining: quota.remaining, limit: quota.limit };
}
