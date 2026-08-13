/** Turning a flat lead list into an organized, prioritized one.
 *
 * Four things make a lead more useful (per Joel): it's genuinely new (not a
 * cert renewal), it has a contact email, it's Shopify Plus, and which market
 * it's in. This module centralises those judgements so the dashboard and the
 * Sheet export rank leads the same way.
 */

import type { Lead } from "./leads";

export type Market = "South Africa" | "Africa" | "Japan" | "Other";

const AFRICA_EX_ZA = new Set([
  "NG", "KE", "GH", "EG", "MA", "TZ", "UG", "ZM", "BW", "NA", "MU", "RW",
]);

export function marketOf(lead: Lead): Market {
  const c = (lead.country ?? "").toUpperCase();
  if (c === "ZA") return "South Africa";
  if (c === "JP") return "Japan";
  if (AFRICA_EX_ZA.has(c)) return "Africa";
  // Fall back to the domain's TLD when country wasn't classified.
  if (lead.domain.endsWith(".za")) return "South Africa";
  if (lead.domain.endsWith(".jp")) return "Japan";
  return "Other";
}

/** Genuinely new: oldest product created within the last ~60 days. CT logs
 *  catch cert renewals too, so a store whose first product is years old was
 *  merely re-seen, not launched. No date => unknown, treated as not-new. */
export function isNewLaunch(lead: Lead, asOf: Date = new Date()): boolean {
  if (!lead.firstProductAt) return false;
  const first = new Date(lead.firstProductAt).getTime();
  if (Number.isNaN(first)) return false;
  const days = (asOf.getTime() - first) / 864e5;
  return days >= 0 && days <= 60;
}

/** Higher = more useful. Additive so the reasons stay legible:
 *  Plus (8) > new launch (4) > has email (2) > has payment intel (1),
 *  with recency of discovery as the tie-breaker. */
export function priorityScore(lead: Lead, asOf: Date = new Date()): number {
  let score = 0;
  if (lead.plus) score += 8;
  if (isNewLaunch(lead, asOf)) score += 4;
  if (lead.email) score += 2;
  if (lead.payments?.length) score += 1;
  return score;
}

export type SortKey = "priority" | "newest" | "launched";

export function sortLeads(leads: Lead[], key: SortKey): Lead[] {
  const now = new Date();
  const copy = [...leads];
  if (key === "newest") {
    copy.sort((a, b) => (b.firstSeen ?? "").localeCompare(a.firstSeen ?? ""));
  } else if (key === "launched") {
    copy.sort((a, b) =>
      (b.firstProductAt ?? "").localeCompare(a.firstProductAt ?? ""),
    );
  } else {
    copy.sort((a, b) => {
      const d = priorityScore(b, now) - priorityScore(a, now);
      return d !== 0 ? d : (b.firstSeen ?? "").localeCompare(a.firstSeen ?? "");
    });
  }
  return copy;
}

export function isNewThisWeek(lead: Lead, asOf: Date = new Date()): boolean {
  if (!lead.firstSeen) return false;
  const weekAgo = new Date(asOf.getTime() - 7 * 864e5).toISOString().slice(0, 10);
  return lead.firstSeen >= weekAgo;
}
