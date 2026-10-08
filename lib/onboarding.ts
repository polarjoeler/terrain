/** Customer onboarding — the TYPED preference model (the backbone of the 5-stage profiler).
 *
 *  This module is pure + client-safe (no DB, no server-only imports) so the flow component, the live
 *  "Your Terrain workspace" summary, the progress indicator and the server persistence all derive from
 *  ONE source of truth. Storage lives in lib/onboarding-store.ts; this is the shape + the pure logic
 *  (what's applicable, progress, the live summary) that both sides share.
 *
 *  Principles from the spec:
 *   - Structured, typed preferences — never free-text blobs.
 *   - "all" is distinct from an empty selection (allPlatforms vs platforms: []).
 *   - Platform ranking is preserved (platforms[] is an ordered priority list).
 *   - Onboarding completion is tracked separately from integration readiness.
 *   - Conditional questions that don't apply are excluded from progress AND the launch summary.
 */

import { marketLabel } from "./markets";

/* ------------------------------------------------------------------ stage 1 --- */
export type CompanyType =
  | "payments" | "ecommerce_platform" | "marketing_tech" | "shipping"
  | "agency" | "hosting" | "theme_dev" | "merchant" | "other";
export const COMPANY_TYPES: { id: CompanyType; label: string; desc: string }[] = [
  { id: "payments", label: "Payments provider", desc: "Gateways, PSPs, BNPL, wallets" },
  { id: "ecommerce_platform", label: "Ecommerce platform", desc: "A CMS or store builder" },
  { id: "marketing_tech", label: "Marketing technology", desc: "Email, reviews, ads, CRO apps" },
  { id: "shipping", label: "Shipping & logistics", desc: "Carriers, fulfilment, couriers" },
  { id: "agency", label: "Agency", desc: "You build or grow stores for clients" },
  { id: "hosting", label: "Hosting provider", desc: "Infrastructure & managed hosting" },
  { id: "theme_dev", label: "Theme developer", desc: "Themes & storefront templates" },
  { id: "merchant", label: "Merchant", desc: "You run your own store(s)" },
  { id: "other", label: "Other", desc: "Something else" },
];

export const ROLES = ["Sales", "Partnerships", "Marketing", "Product", "Research", "Leadership"] as const;
export type Role = (typeof ROLES)[number];

export type Goal =
  | "find_leads" | "track_cms" | "country_performance"
  | "my_tech_performance" | "fraud_monitoring";
export const GOALS: { id: Goal; label: string; desc: string }[] = [
  { id: "find_leads", label: "Find ecommerce leads", desc: "Discover merchants to sell to" },
  { id: "track_cms", label: "Track CMS & platform activity", desc: "New stores, migrations, adoption" },
  { id: "country_performance", label: "Monitor performance by country", desc: "Market-level ecommerce activity" },
  { id: "my_tech_performance", label: "Understand my technology's market", desc: "Where your product wins & loses" },
  { id: "fraud_monitoring", label: "Detect suspected fraud", desc: "Flag clone/abuse signals across your base" },
];
/** Fraud monitoring is only offered to companies whose customer base IS the merchant universe. */
export const isFraudEligible = (ct?: CompanyType): boolean => ct === "payments" || ct === "ecommerce_platform";

export type TechCategory = "payments" | "marketing" | "shipping" | "themes" | "hosting" | "ecommerce_platform";
export const TECH_CATEGORIES: { id: TechCategory; label: string }[] = [
  { id: "payments", label: "Payments" }, { id: "marketing", label: "Marketing" },
  { id: "shipping", label: "Shipping" }, { id: "themes", label: "Themes" },
  { id: "hosting", label: "Hosting" }, { id: "ecommerce_platform", label: "Ecommerce platform" },
];
export type TechProduct = { name: string; category: TechCategory };

/* ------------------------------------------------------------------ stage 2 --- */
// Size bands Terrain actually supports. Revenue is ESTIMATED (modelled); catalog size is OBSERVED.
export type SizeBand = "rev_100k_plus" | "rev_25_100k" | "rev_5_25k" | "rev_1_5k" | "rev_under_1k" | "cat_large" | "cat_small";
export const SIZE_BANDS: { id: SizeBand; label: string; basis: "estimated" | "observed" }[] = [
  { id: "rev_100k_plus", label: "$100k+/mo revenue", basis: "estimated" },
  { id: "rev_25_100k", label: "$25k–100k/mo", basis: "estimated" },
  { id: "rev_5_25k", label: "$5k–25k/mo", basis: "estimated" },
  { id: "rev_1_5k", label: "$1k–5k/mo", basis: "estimated" },
  { id: "rev_under_1k", label: "Under $1k/mo", basis: "estimated" },
  { id: "cat_large", label: "Large catalogue (100+ products)", basis: "observed" },
  { id: "cat_small", label: "Small catalogue (<100)", basis: "observed" },
];

export type Targeting = {
  allPlatforms: boolean; platforms: string[];            // ordered priority (platform ids). all ⇒ no preference
  sizeAny: boolean; sizeBands: SizeBand[]; unknownSizeOk: boolean;
  allCategories: boolean; categories: string[]; excludeCategories: string[];
  allCountries: boolean; countries: string[];            // ISO2
};
export const emptyTargeting = (): Targeting => ({
  allPlatforms: false, platforms: [], sizeAny: true, sizeBands: [], unknownSizeOk: true,
  allCategories: false, categories: [], excludeCategories: [], allCountries: false, countries: [],
});

/* ------------------------------------------------------------------ stage 3 --- */
export type DigestCadence = "weekly" | "monthly";
export type CmsDigest = { allPlatforms: boolean; platforms: string[]; allCountries: boolean; countries: string[]; cadence: DigestCadence; reuseTargeting: boolean };
export type CountryDigest = { countries: string[] };
export type TechDeepDive = { techs: string[]; allMarkets: boolean; markets: string[]; recurring: boolean; cadence: DigestCadence };
export type FraudMonitoring = { enabled: boolean; status: "pending_setup" };

/* ------------------------------------------------------------------ stage 4 --- */
export type Channel = "email" | "slack" | "whatsapp" | "crm";
// Which channels are actually wired today — the rest render "Requires setup" and never imply a connection.
export const CHANNEL_READY: Record<Channel, boolean> = { email: true, slack: false, whatsapp: false, crm: false };
export const CHANNELS: { id: Channel; label: string; scope: "personal" | "org" }[] = [
  { id: "email", label: "Email", scope: "personal" }, { id: "slack", label: "Slack", scope: "org" },
  { id: "whatsapp", label: "WhatsApp", scope: "personal" }, { id: "crm", label: "CRM", scope: "org" },
];
export type Schedule = { tz: string; day?: string; time?: string; dayOfMonth?: number };
export type Delivery = {
  channels: Channel[];
  email?: string;
  whatsappNumber?: string; whatsappConsent?: boolean;
  useForAllDigests: boolean;
  schedule: Schedule;
};
export const emptyDelivery = (): Delivery => ({
  channels: ["email"], useForAllDigests: true,
  schedule: { tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "Africa/Johannesburg", day: "Monday", time: "08:00" },
});

/* ------------------------------------------------------------------ stage 5 --- */
export type Seats = { count: number; includesSelf: boolean; pending: boolean };

/* ------------------------------------------------------- the resumable state --- */
export type OnboardingState = {
  stage: number;                     // furthest stage reached (1-5)
  // stage 1
  companyName?: string; website?: string; companyType?: CompanyType; role?: Role;
  goals: Goal[]; technologies: TechProduct[];
  // stage 2
  targeting?: Targeting;
  // stage 3
  cmsDigest?: CmsDigest; countryDigest?: CountryDigest; techDeepDive?: TechDeepDive;
  fraud?: FraudMonitoring;
  // stage 4
  delivery?: Delivery;
  // stage 5
  seats?: Seats;
  updatedAt?: string;
};
export const emptyState = (): OnboardingState => ({ stage: 1, goals: [], technologies: [] });

export const STAGES = ["Your company", "Your ideal merchants", "Your intelligence", "Delivery preferences", "Review & launch"] as const;
export type StageIndex = 1 | 2 | 3 | 4 | 5;

const hasGoal = (s: OnboardingState, g: Goal) => s.goals.includes(g);
const wantsTech = (s: OnboardingState) => hasGoal(s, "my_tech_performance") || hasGoal(s, "fraud_monitoring");

/* ------------------------------------------------- applicability + progress --- */
// A flat list of questions with: which stage, does it apply to THIS state, and is it answered.
// Progress is computed only over applicable questions (skipped conditionals never count).
type Q = { stage: StageIndex; applies: (s: OnboardingState) => boolean; answered: (s: OnboardingState) => boolean };
const QUESTIONS: Q[] = [
  // Stage 1
  { stage: 1, applies: () => true, answered: (s) => !!s.companyType },
  { stage: 1, applies: () => true, answered: (s) => !!s.role },
  { stage: 1, applies: () => true, answered: (s) => s.goals.length > 0 },
  { stage: 1, applies: wantsTech, answered: (s) => s.technologies.length > 0 },
  // Stage 2 — only when finding leads
  { stage: 2, applies: (s) => hasGoal(s, "find_leads"), answered: (s) => !!s.targeting && (s.targeting.allPlatforms || s.targeting.platforms.length > 0) },
  { stage: 2, applies: (s) => hasGoal(s, "find_leads"), answered: (s) => !!s.targeting && (s.targeting.sizeAny || s.targeting.sizeBands.length > 0) },
  { stage: 2, applies: (s) => hasGoal(s, "find_leads"), answered: (s) => !!s.targeting && (s.targeting.allCategories || s.targeting.categories.length > 0) },
  { stage: 2, applies: (s) => hasGoal(s, "find_leads"), answered: (s) => !!s.targeting && (s.targeting.allCountries || s.targeting.countries.length > 0) },
  // Stage 3 — per goal
  { stage: 3, applies: (s) => hasGoal(s, "track_cms"), answered: (s) => !!s.cmsDigest },
  { stage: 3, applies: (s) => hasGoal(s, "country_performance"), answered: (s) => !!s.countryDigest && s.countryDigest.countries.length > 0 },
  { stage: 3, applies: (s) => hasGoal(s, "my_tech_performance"), answered: (s) => !!s.techDeepDive && s.techDeepDive.techs.length > 0 },
  { stage: 3, applies: (s) => hasGoal(s, "fraud_monitoring") && isFraudEligible(s.companyType), answered: (s) => !!s.fraud },
  // Stage 4
  { stage: 4, applies: () => true, answered: (s) => !!s.delivery && s.delivery.channels.length > 0 },
  // Stage 5 (seat count only asked for a first org owner — the flow passes that in; treat as applicable)
  { stage: 5, applies: () => true, answered: (s) => !!s.seats },
];

export function stageApplies(s: OnboardingState, stage: StageIndex): boolean {
  return QUESTIONS.some((q) => q.stage === stage && q.applies(s));
}
/** Within a stage: how many questions apply and how many are answered. */
export function stageProgress(s: OnboardingState, stage: StageIndex): { answered: number; total: number } {
  const qs = QUESTIONS.filter((q) => q.stage === stage && q.applies(s));
  return { answered: qs.filter((q) => q.answered(s)).length, total: qs.length };
}
/** Overall progress across every applicable question. */
export function progress(s: OnboardingState): { answered: number; total: number; pct: number } {
  const qs = QUESTIONS.filter((q) => q.applies(s));
  const answered = qs.filter((q) => q.answered(s)).length;
  return { answered, total: qs.length, pct: qs.length ? Math.round((100 * answered) / qs.length) : 0 };
}

/* --------------------------------------- the live "Your Terrain workspace" --- */
// Concrete outcome lines, in spec order. Only includes active configurations.
const platName = (id: string, labels: Record<string, string>) => labels[id] ?? id;
const andList = (xs: string[], max = 3): string => {
  const shown = xs.slice(0, max);
  const tail = xs.length > max ? ` +${xs.length - max} more` : "";
  if (shown.length === 0) return "";
  if (shown.length === 1) return shown[0] + tail;
  return shown.slice(0, -1).join(", ") + " and " + shown[shown.length - 1] + tail;
};

export type SummaryLine = { key: string; text: string };
/** `platformLabels` maps platform id → display name (passed in so this stays dependency-light). */
export function summary(s: OnboardingState, platformLabels: Record<string, string> = {}): SummaryLine[] {
  const out: SummaryLine[] = [];
  if (s.companyType) {
    const ct = COMPANY_TYPES.find((c) => c.id === s.companyType)?.label;
    out.push({ key: "company", text: `${s.companyName ? s.companyName + " — " : ""}${ct}` });
  }
  const t = s.targeting;
  if (hasGoal(s, "find_leads") && t) {
    if (t.allPlatforms) out.push({ key: "leads-plat", text: "Leads across all platforms" });
    else if (t.platforms.length) out.push({ key: "leads-plat", text: `${andList(t.platforms.map((p) => platName(p, platformLabels)))} leads, prioritised in that order` });
    const where = t.allCountries ? "all covered African markets" : t.countries.length ? andList(t.countries.map(marketLabelSafe)) : "";
    const cats = t.allCategories ? "" : t.categories.length ? andList(t.categories) + " " : "";
    if (where) out.push({ key: "leads-where", text: `${cats ? cats + "merchants" : "Merchants"} in ${where}`.trim() });
    if (!t.sizeAny && t.sizeBands.length) out.push({ key: "leads-size", text: `${andList(t.sizeBands.map((b) => SIZE_BANDS.find((x) => x.id === b)?.label ?? b))}` });
  }
  if (hasGoal(s, "track_cms") && s.cmsDigest) {
    const d = s.cmsDigest;
    const plats = d.reuseTargeting
      ? (t?.allPlatforms ? "all platforms" : t?.platforms.length ? andList(t.platforms.map((p) => platName(p, platformLabels))) : "your target platforms")
      : d.allPlatforms ? "all platforms" : andList(d.platforms.map((p) => platName(p, platformLabels)));
    out.push({ key: "cms", text: `${cap(d.cadence)} ${plats} activity digest` });
  }
  if (hasGoal(s, "country_performance") && s.countryDigest?.countries.length) {
    out.push({ key: "country", text: `Weekly country performance: ${andList(s.countryDigest.countries.map(marketLabelSafe))}` });
  }
  if (hasGoal(s, "my_tech_performance") && s.techDeepDive?.techs.length) {
    out.push({ key: "tech-dd", text: `${s.techDeepDive.recurring ? cap(s.techDeepDive.cadence) + " deep dives" : "One-off deep dive"}: ${andList(s.techDeepDive.techs)}` });
  }
  if (hasGoal(s, "fraud_monitoring") && s.fraud?.enabled && isFraudEligible(s.companyType)) {
    out.push({ key: "fraud", text: "Suspected-fraud monitoring (setup required)" });
  }
  if (s.delivery?.channels.length) {
    const names = s.delivery.channels.map((c) => CHANNELS.find((x) => x.id === c)?.label ?? c);
    const notReady = s.delivery.channels.filter((c) => !CHANNEL_READY[c]);
    out.push({ key: "delivery", text: `Delivery by ${andList(names)}${notReady.length ? " (some need setup)" : ""}` });
  }
  if (s.seats && s.seats.count > 0) out.push({ key: "seats", text: `${s.seats.count} seat${s.seats.count === 1 ? "" : "s"} (billing pending)` });
  return out;
}

function marketLabelSafe(iso: string): string {
  // marketLabel returns "🇿🇦 South Africa"; strip the flag (2 regional-indicator code points) + space
  // for the summary prose by dropping everything up to the first letter.
  return marketLabel(iso).replace(/^[^\p{L}]+/u, "");
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
