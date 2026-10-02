"use server";

/** Server action behind the leads browser: filtering/paging/facets run in SQL (lib/browse.ts),
 *  so the client fetches a 50-row page + true facet counts instead of holding ~13k rows in memory.
 *  Paywalled — paid subscribers or the owner only (same gate as the page). */
import { browseQuery, type BrowseFilters, type BrowseResult } from "@/lib/browse";
import { currentUser, isAdmin } from "@/lib/auth";
import { getSubscriber, hasAccess } from "@/lib/subscriptions";

export async function browse(filters: BrowseFilters): Promise<BrowseResult | { error: string }> {
  const email = await currentUser();
  if (!email) return { error: "unauthorized" };
  const sub = await getSubscriber(email).catch(() => null);
  if (!hasAccess(sub) && !isAdmin(email)) return { error: "no_access" };
  // Clamp the page size so a crafted filter can't pull a huge result.
  const safe: BrowseFilters = { ...filters, limit: Math.min(filters.limit ?? 50, 100) };
  return browseQuery(safe);
}
