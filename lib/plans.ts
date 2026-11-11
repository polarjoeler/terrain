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
  /** Canonical `imported_stores.platform` values this plan may see, or NULL for every platform
   *  we track. Enforced server-side in browseQuery AND export; a client-side filter would be
   *  decorative. null is the same "unrestricted" sentinel admins already use — see scopeFilters
   *  in lib/export-gate, which simply omits the filter when the scope is null. */
  platforms: string[] | null;
  /** Rows per calendar month. null = unmetered (matching Store Leads, which gates export
   *  by plan rather than capping it). See USAGE_ALERT_ROWS for the unadvertised backstop. */
  exportLimit: number | null;
  seats: number;
  extraSeatUsd: number;
  reportTiers: ReportTier[];
  /** Connect an outreach tool / CRM and push leads into it (the Connections panel).
   *
   *  Partner-only, decided 2026-11-09. A push is the highest-leverage export we offer — it moves
   *  contactable leads in bulk into a sender we don't control — and Partner is both the tier whose
   *  buyer actually runs sequences and the tier that already unlocks the Woo half of the base the
   *  push would draw from. Metering alone wasn't the right gate: a $69 Leads seat could spend its
   *  500 rows straight into a third-party sender every month. */
  integrations: boolean;
};

export const PLANS: Record<PlanKey, Plan> = {
  leads: {
    key: "leads", label: "Leads",
    monthlyUsd: 69, annualUsd: null,
    platforms: ["Shopify"],
    exportLimit: 500,
    seats: 1, extraSeatUsd: 30,
    reportTiers: [],
    integrations: false,
  },
  intelligence: {
    key: "intelligence", label: "Intelligence",
    monthlyUsd: 199, annualUsd: 1592,        // 199 x 8
    platforms: ["Shopify"],
    exportLimit: null,
    seats: 2, extraSeatUsd: 30,
    reportTiers: ["core", "team"],
    integrations: false,
  },
  partner: {
    key: "partner", label: "Partner",
    monthlyUsd: 399, annualUsd: 3192,        // 399 x 8
    // EVERY platform, not a list. Woo is the biggest single addition but it was never the whole
    // offer: in the visible markets there are 10,363 published non-Shopify/non-Woo stores — 6,452
    // Selar, 1,435 Wix, 677 ShopStar, 583 PrestaShop, 325 Magento and a long tail — and naming two
    // platforms both undersold the tier and, because this list is the server-side whitelist, really
    // did hide the rest from paying Partner customers.
    platforms: null,
    exportLimit: null,
    seats: 3, extraSeatUsd: 30,
    reportTiers: ["core", "team", "pro"],    // 'pro' = the provider-specific reports
    integrations: true,
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

/** Months billed on the 2027 annual promo — 8, i.e. 4 months free. DERIVED from the ladder
 *  rather than restated, because an annual seat price that drifted from the annual plan prices
 *  would be invisible until someone's invoice was wrong. */
export const ANNUAL_MONTHS_BILLED = PLANS.intelligence.annualUsd! / PLANS.intelligence.monthlyUsd;

/** A seat on an annual subscription. Stripe refuses to mix billing intervals inside one
 *  subscription, so an annual plan needs an annual seat price — a monthly one cannot be added
 *  to it at all. */
export const EXTRA_SEAT_ANNUAL_USD = EXTRA_SEAT_USD * ANNUAL_MONTHS_BILLED;

/** Hard ceiling on seats bought in one go. Not a business limit — a fat-finger limit, so a
 *  stray keystroke can't start a four-figure subscription. */
export const MAX_EXTRA_SEATS = 50;


/** Unmetered plans are still COUNTED — we just don't refuse. Crossing this in a month
 *  notifies us to look, rather than blocking a legitimate BD team mid-quarter. One month
 *  of Intelligence is otherwise the whole Shopify base (40,922 rows). */
export const USAGE_ALERT_ROWS = 15000;

/** Rows a month a TRIAL may export, on a plan whose paid allowance is unmetered.
 *
 *  Decided 2026-11-11. A trial that cannot export at all can't be evaluated by the buyer who cares
 *  most about the data being real — the first thing a payments or BD team does is take rows into
 *  their own tooling. But an unmetered trial IS the product, so the trial borrows the entry tier's
 *  monthly cap: enough to prove the rows are genuine, not enough to be the whole evaluation.
 *
 *  Derived from the Leads allowance rather than restated — two numbers that have to agree would
 *  drift, and the entry tier's cap already encodes "how much export is a sample". A trial on Leads
 *  itself gets nothing: that 500 is the paid product, so there is no smaller allowance to meter it
 *  down to. See exportEntitlement() in lib/subscriptions.ts, which is the only place this applies. */
export const TRIAL_EXPORT_ROWS = PLANS.leads.exportLimit!;

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

/** Platforms this plan may see, or null for unrestricted. Used to scope BOTH the browse query and
 *  the export — callers must treat null as "no platform filter", not as "nothing". */
export const platformsFor = (raw: string | null | undefined): string[] | null => planOf(raw).platforms;

/** Rows/month, or null for unmetered. */
export const exportLimitFor = (raw: string | null | undefined): number | null => planOf(raw).exportLimit;

/** Seats a plan carries before any extra are bought — the payer included. */
export const seatsFor = (raw: string | null | undefined): number => planOf(raw).seats;

/** Does this plan unlock a report at `tier`? The single check the catalog asked for. */
export function hasInsightAccess(tier: ReportTier, raw: string | null | undefined): boolean {
  return planOf(raw).reportTiers.includes(tier);
}

/** May this plan push leads into a connected tool? */
export const hasIntegrations = (raw: string | null | undefined): boolean => planOf(raw).integrations;

/** Cheapest plan that unlocks Connections — for the upgrade copy, so the tier and its price are
 *  never restated in a page. */
export const minPlanForIntegrations = (): Plan =>
  PLANS[PLAN_ORDER.find((k) => PLANS[k].integrations) ?? "partner"];

/** Cheapest plan that unlocks a report tier — for "upgrade to X to see this" copy. */
export function minPlanFor(tier: ReportTier): Plan {
  return PLANS[PLAN_ORDER.find((k) => PLANS[k].reportTiers.includes(tier)) ?? "partner"];
}
