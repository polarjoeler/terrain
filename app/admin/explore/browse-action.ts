"use server";

/** Server action behind the leads browser: filtering/paging/facets run in SQL (lib/browse.ts),
 *  so the client fetches a 50-row page + true facet counts instead of holding ~13k rows in memory.
 *  Paywalled — paid subscribers or the owner only (same gate as the page). */
import { browseQuery, type BrowseFilters, type BrowseResult } from "@/lib/browse";
import { currentUser, isAdmin } from "@/lib/auth";
import { getSubscriber, hasAccess } from "@/lib/subscriptions";
import { platformsFor } from "@/lib/plans";

export async function browse(filters: BrowseFilters): Promise<BrowseResult | { error: string }> {
  const email = await currentUser();
  if (!email) return { error: "unauthorized" };
  const sub = await getSubscriber(email).catch(() => null);
  if (!hasAccess(sub) && !isAdmin(email)) return { error: "no_access" };
  // Clamp the page size so a crafted filter can't pull a huge result.
  // Plan scope is re-applied here, never trusted from the client: the dashboard's first paint is
  // scoped server-side, but every refetch after a filter change comes through this action, and
  // without it a Shopify-only plan saw WooCommerce rows from the first filter change on.
  const planPlatforms = isAdmin(email) ? undefined : (platformsFor(sub?.plan) ?? undefined);
  const safe: BrowseFilters = { ...filters, planPlatforms, limit: Math.min(filters.limit ?? 50, 100) };
  return browseQuery(safe);
}
