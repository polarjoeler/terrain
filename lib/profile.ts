/** Seat profiles — the onboarding profiler that tailors Terrain per user and makes a shared
 *  login self-defeating (personalisation is the friendliest anti-sharing lever).
 *
 *  There's no org/team table yet, so the COMPANY is keyed on the email DOMAIN: the first user
 *  at paystack.com fills the company profile; later paystack.com users get the short profiler
 *  (just their own digest + lead prefs). Generic inboxes (gmail/outlook/…) are treated as their
 *  own one-person org, so consumer emails don't share a company profile.
 *
 *    org_profile  (domain PK)   — company persona, CMS focus, self-tracking, extras.
 *    user_profile (email PK)    — per-seat lead cadence, focus, ingestion, digest opt-in.
 */
import postgres from "postgres";

let _sql: ReturnType<typeof postgres> | null = null;
function db() {
  if (!_sql) _sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 3, idle_timeout: 20 });
  return _sql;
}

// Consumer inboxes — each such email is its own company, not grouped by domain.
const GENERIC_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com",
  "icloud.com", "me.com", "proton.me", "protonmail.com", "aol.com", "gmx.com", "mail.com",
]);

/** The org key for an email: its domain for company inboxes, else the whole email. */
export function orgKey(email: string): string {
  const e = email.trim().toLowerCase();
  const domain = e.split("@")[1] || "";
  return domain && !GENERIC_EMAIL_DOMAINS.has(domain) ? domain : e;
}

export type CompanyType = "payments" | "app_developer" | "investor" | "researcher" | "shipping" | "agency" | "other";
export type LeadCadence = "daily" | "weekly" | "monthly";
export type Ingestion = "crm" | "csv" | "api" | "in_app";

export type OrgProfile = {
  org: string;
  companyType: CompanyType;
  cmsFocus: string[];              // shopify / woocommerce / magento / wix / all
  trackOwnPerformance: boolean;    // they ARE a provider and want their own perf + weekly digest
  extras: string | null;          // free-text "any other features you want"
  createdBy: string;
  createdAt: string;
};
export type UserProfile = {
  email: string;
  org: string;
  isFirstUser: boolean;
  leadCadence: LeadCadence;
  leadFocus: string[];            // CMS/segments they want leads for
  ingestion: Ingestion;
  digest: boolean;                // weekly digest opt-in
  completedAt: string | null;
};

async function ensureTables(sql: ReturnType<typeof db>) {
  await sql`CREATE TABLE IF NOT EXISTS org_profile (
    org text PRIMARY KEY, company_type text, cms_focus text[] DEFAULT '{}',
    track_own_performance boolean DEFAULT false, extras text,
    created_by text, created_at timestamptz NOT NULL DEFAULT now())`;
  await sql`CREATE TABLE IF NOT EXISTS user_profile (
    email text PRIMARY KEY, org text, is_first_user boolean DEFAULT false,
    lead_cadence text, lead_focus text[] DEFAULT '{}', ingestion text,
    digest boolean DEFAULT true, completed_at timestamptz)`;
}

export async function getUserProfile(email: string): Promise<UserProfile | null> {
  const sql = db();
  try {
    const [r] = await sql`SELECT * FROM user_profile WHERE email = ${email.trim().toLowerCase()}`;
    if (!r) return null;
    return {
      email: r.email, org: r.org, isFirstUser: r.is_first_user,
      leadCadence: r.lead_cadence, leadFocus: r.lead_focus ?? [], ingestion: r.ingestion,
      digest: r.digest, completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
    };
  } catch { return null; }   // table not created yet
}

export async function getOrgProfile(org: string): Promise<OrgProfile | null> {
  const sql = db();
  try {
    const [r] = await sql`SELECT * FROM org_profile WHERE org = ${org}`;
    if (!r) return null;
    return {
      org: r.org, companyType: r.company_type, cmsFocus: r.cms_focus ?? [],
      trackOwnPerformance: r.track_own_performance, extras: r.extras,
      createdBy: r.created_by, createdAt: new Date(r.created_at).toISOString(),
    };
  } catch { return null; }
}

/** Does this email's org already have a company profile? (→ decides short vs full onboarding.) */
export async function orgHasProfile(email: string): Promise<boolean> {
  return (await getOrgProfile(orgKey(email))) != null;
}

export type OnboardingInput = {
  // company-level (only from the first user of an org)
  companyType?: CompanyType;
  cmsFocus?: string[];
  trackOwnPerformance?: boolean;
  extras?: string;
  // per-user (always)
  leadCadence: LeadCadence;
  leadFocus: string[];
  ingestion: Ingestion;
  digest: boolean;
};

export async function saveOnboarding(email: string, input: OnboardingInput): Promise<void> {
  const sql = db();
  await ensureTables(sql);
  const e = email.trim().toLowerCase();
  const org = orgKey(e);
  const firstUser = !(await getOrgProfile(org));

  if (firstUser && input.companyType) {
    await sql`INSERT INTO org_profile (org, company_type, cms_focus, track_own_performance, extras, created_by)
      VALUES (${org}, ${input.companyType}, ${input.cmsFocus ?? []}, ${input.trackOwnPerformance ?? false}, ${input.extras ?? null}, ${e})
      ON CONFLICT (org) DO NOTHING`;
  }
  await sql`INSERT INTO user_profile (email, org, is_first_user, lead_cadence, lead_focus, ingestion, digest, completed_at)
    VALUES (${e}, ${org}, ${firstUser}, ${input.leadCadence}, ${input.leadFocus}, ${input.ingestion}, ${input.digest}, now())
    ON CONFLICT (email) DO UPDATE SET
      lead_cadence = EXCLUDED.lead_cadence, lead_focus = EXCLUDED.lead_focus,
      ingestion = EXCLUDED.ingestion, digest = EXCLUDED.digest, completed_at = now()`;
}
