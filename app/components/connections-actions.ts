"use server";

import { currentUser, isAdmin } from "@/lib/auth";
import { getSubscriber, hasAccess } from "@/lib/subscriptions";
import { platformsFor } from "@/lib/plans";
import { outreachCounts } from "@/lib/imported";

export type CohortCounts = { reachable: number; all: number };

/** Cohort sizes for the Connections panel, so the customer sees what a push would cost and what
 *  share of it actually reaches a person BEFORE spending export rows on it.
 *
 *  Gated on access rather than through lib/export-gate, because a COUNT is not an export: it
 *  returns two integers and no address. That distinction matters twice over — it keeps
 *  export-gate's "one gate, no third place" promise about the surfaces that do hand over data,
 *  and it lets a trialling account see the size of what it would be able to push once it
 *  upgrades, which is the only reason to show them the panel at all.
 *
 *  Scope and tag rules mirror the push route on purpose: the plan's platform ceiling applies, so
 *  the number shown is the number that would be sent, and cohort tags stay admin-only curation.
 */
export async function cohortCountsAction(
  country?: string,
  tag?: string,
): Promise<{ ok: true; counts: CohortCounts } | { ok: false; error: string }> {
  const email = await currentUser();
  if (!email) return { ok: false, error: "Please sign in again." };

  const admin = isAdmin(email);
  let platforms: string[] | null = null;
  if (!admin) {
    const sub = await getSubscriber(email).catch(() => null);
    if (!hasAccess(sub)) return { ok: false, error: "Your subscription doesn't include lead data." };
    platforms = platformsFor(sub?.plan);
  }

  try {
    const counts = await outreachCounts({
      country: country || undefined,
      tag: admin ? tag || undefined : undefined,
      platforms,
    });
    return { ok: true, counts };
  } catch {
    return { ok: false, error: "Couldn't size that cohort — please try again." };
  }
}
