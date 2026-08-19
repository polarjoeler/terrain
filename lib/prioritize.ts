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

/** The genuine "found first" date: the cert-transparency discovery date when we
 *  have it (synced from the feed), else the store's first_seen. This is what
 *  "newest" and the time-window filters key off — NOT firstSeen, which on the
 *  bulk-imported base holds the store's historical launch date. */
export function foundDate(lead: Lead): string {
  return lead.discoveredAt || lead.firstSeen || "";
}

/** Combined social audience (Instagram + Facebook followers). A high number
 *  signals an established, higher-value store. */
export function socialReach(lead: Lead): number {
  return (lead.instagramFollowers ?? 0) + (lead.facebookFollowers ?? 0);
}

/** Found (discovered) within the last N days. */
export function foundWithin(lead: Lead, days: number, asOf: Date = new Date()): boolean {
  const d = foundDate(lead);
  if (!d) return false;
  const cutoff = new Date(asOf.getTime() - days * 864e5).toISOString().slice(0, 10);
  return d >= cutoff;
}

/** Genuinely new: discovered in the last ~30 days (the discovery feed's window),
 *  or first product created within the last ~60 days when we have that date. */
export function isNewLaunch(lead: Lead, asOf: Date = new Date()): boolean {
  if (foundWithin(lead, 30, asOf)) return true;
  if (!lead.firstProductAt) return false;
  const first = new Date(lead.firstProductAt).getTime();
  if (Number.isNaN(first)) return false;
  const days = (asOf.getTime() - first) / 864e5;
  return days >= 0 && days <= 60;
}

/** Higher = more useful. Additive so the reasons stay legible. Weights the three
 *  value signals Joel called out: freshly found, big (est. sales), high social —
 *  plus Plus, contactability and payment intel. */
export function priorityScore(lead: Lead, asOf: Date = new Date()): number {
  let score = 0;
  if (lead.plus) score += 8;
  if (foundWithin(lead, 7, asOf)) score += 6;
  else if (foundWithin(lead, 30, asOf)) score += 3;
  const ems = lead.estMonthlySales ?? 0;
  if (ems >= 50_000) score += 4;
  else if (ems >= 10_000) score += 2;
  const social = socialReach(lead);
  if (social >= 50_000) score += 3;
  else if (social >= 5_000) score += 1;
  if (lead.email) score += 2;
  if (lead.payments?.length) score += 1;
  return score;
}

export type SortKey = "priority" | "newest" | "size" | "social" | "launched";

const cmpDateDesc = (a: string, b: string) => b.localeCompare(a);
const cmpNumDesc = (a: number, b: number) => b - a;

export function sortLeads(leads: Lead[], key: SortKey): Lead[] {
  const now = new Date();
  const copy = [...leads];
  if (key === "newest") {
    copy.sort((a, b) => cmpDateDesc(foundDate(a), foundDate(b)));
  } else if (key === "size") {
    copy.sort((a, b) => cmpNumDesc(a.estMonthlySales ?? -1, b.estMonthlySales ?? -1));
  } else if (key === "social") {
    copy.sort((a, b) => cmpNumDesc(socialReach(a), socialReach(b)));
  } else if (key === "launched") {
    copy.sort((a, b) => cmpDateDesc(a.firstProductAt ?? "", b.firstProductAt ?? ""));
  } else {
    copy.sort((a, b) => {
      const d = priorityScore(b, now) - priorityScore(a, now);
      return d !== 0 ? d : cmpDateDesc(foundDate(a), foundDate(b));
    });
  }
  return copy;
}

export function isNewThisWeek(lead: Lead, asOf: Date = new Date()): boolean {
  return foundWithin(lead, 7, asOf);
}
