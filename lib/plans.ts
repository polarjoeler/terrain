/** The single source of truth for what each plan may do.
 *
 *  Before this, four places disagreed about what the plans even were: subscriptions.ts had
 *  starter|pro, insights-catalog.ts gated against core|team|pro, the billing page showed
 *  Starter|Pro, and the priced tiers were different again. The catalog's 13 `team` and 3
 *  `core` gates could never evaluate true, because neither existed as a PlanKey.
 *
 *  Pricing settled 2026-10-29. Deliberately under Store Leads ($75 browse-only / $250 Pro /
 *  $450 Elite), and the platform scope is the spine of the ladder rather than a bolt-on:
 *  Woo is withheld until Partner because it is the RICHER half of the base — 91% tech
 *  coverage and 48% contactable email, against Shopify's 55% and 30% — and the half the
 *  incumbents cover worst. Gating our strongest asset behind the top tier is the point.
 */

export type PlanKey = "leads" | "intelligence" | "partner";

/** Which report tiers a plan unlocks. The catalog's own vocabulary, kept as-is so the
 *  existing badges keep meaning what they say. */
export type ReportTier = "core" | "team" | "pro";

export type Plan = {
  key: PlanKey;
  label: string;
  monthlyUsd: number;
  /** 2027 promotional annual = 4 months free. Null where annual isn't offered (Leads —
   *  the cash isn't worth the support load). */
  annualUsd: number | null;
  /** Canonical `imported_stores.platform` values this plan may see. Enforced server-side
   *  in browseQuery AND export; a client-side filter would be decorative. */
  platforms: string[];
  /** Rows per calendar month. null = unmetered (matching Store Leads, which gates export
   *  by plan rather than capping it). See USAGE_ALERT_ROWS for the unadvertised backstop. */
  exportLimit: number | null;
  seats: number;
  extraSeatUsd: number;
  reportTiers: ReportTier[];
};

export const PLANS: Record<PlanKey, Plan> = {
  leads: {
    key: "leads", label: "Leads",
    monthlyUsd: 69, annualUsd: null,
    platforms: ["Shopify"],
    exportLimit: 500,
    seats: 1, extraSeatUsd: 30,
    reportTiers: [],
  },
  intelligence: {
    key: "intelligence", label: "Intelligence",
    monthlyUsd: 199, annualUsd: 1592,        // 199 x 8
    platforms: ["Shopify"],
    exportLimit: null,
    seats: 2, extraSeatUsd: 30,
    reportTiers: ["core", "team"],
  },
  partner: {
    key: "partner", label: "Partner",
    monthlyUsd: 399, annualUsd: 3192,        // 399 x 8
    platforms: ["Shopify", "WooCommerce"],
    exportLimit: null,
    seats: 3, extraSeatUsd: 30,
    reportTiers: ["core", "team", "pro"],    // 'pro' = the provider-specific reports
  },
};

export const PLAN_ORDER: PlanKey[] = ["leads", "intelligence", "partner"];

/** Add-ons, per month on top of any plan. Radar + Partners is sold as one bundle
 *  (decided 2026-10-29). Not to be confused with the standalone Radar monitoring
 *  product sold to brands at R199/mo — different buyer, different Stripe product. */
export const ADDON_RADAR_PARTNERS_USD = 100;

/** Every plan charges the same for an extra seat; asserted here so the Stripe setup
 *  script can create ONE seat price rather than one per plan. */
export const EXTRA_SEAT_USD = 30;

/** Unmetered plans are still COUNTED — we just don't refuse. Crossing this in a month
 *  notifies us to look, rather than blocking a legitimate BD team mid-quarter. One month
 *  of Intelligence is otherwise the whole Shopify base (40,922 rows). */
export const USAGE_ALERT_ROWS = 15000;

/** Legacy plan values still in the DB. Only one subscriber existed at migration
 *  (plan=pro), but the webhook and admin actions can still write the old names until
 *  every path is updated, so resolve rather than assume. */
const LEGACY: Record<string, PlanKey> = { starter: "leads", pro: "intelligence", core: "intelligence", team: "partner" };

export function resolvePlan(raw: string | null | undefined): PlanKey {
  const v = (raw ?? "").trim().toLowerCase();
  if (v in PLANS) return v as PlanKey;
  return LEGACY[v] ?? "leads";
}

export const planOf = (raw: string | null | undefined): Plan => PLANS[resolvePlan(raw)];

/** Platforms this plan may see. Used to scope BOTH the browse query and the export. */
export const platformsFor = (raw: string | null | undefined): string[] => planOf(raw).platforms;

/** Rows/month, or null for unmetered. */
export const exportLimitFor = (raw: string | null | undefined): number | null => planOf(raw).exportLimit;

/** Does this plan unlock a report at `tier`? The single check the catalog asked for. */
export function hasInsightAccess(tier: ReportTier, raw: string | null | undefined): boolean {
  return planOf(raw).reportTiers.includes(tier);
}

/** Cheapest plan that unlocks a report tier — for "upgrade to X to see this" copy. */
export function minPlanFor(tier: ReportTier): Plan {
  return PLANS[PLAN_ORDER.find((k) => PLANS[k].reportTiers.includes(tier)) ?? "partner"];
}
