/** Server persistence for the onboarding profiler. Resumable partial state + a commit-on-launch that
 *  writes the typed, structured preferences — while ALSO keeping the legacy org_profile/user_profile
 *  columns the rest of the app already reads (getOrgProfile, the dashboard persona, dueDigestUsers) in
 *  sync, so nothing downstream breaks.
 *
 *  Onboarding completion (onboarding_completed_at) is tracked SEPARATELY from integration readiness —
 *  a user can finish onboarding while Slack/WhatsApp/fraud setup stays pending.
 */
import { db as sharedDb } from "./db";
import { orgKey } from "./profile";
import type { OnboardingState } from "./onboarding";
import { isFraudEligible } from "./onboarding";

function db() { return sharedDb(); }

let _ensured: Promise<void> | null = null;
function ensure(sql: ReturnType<typeof db>): Promise<void> {
  return (_ensured ??= (async () => {
    // Base tables are created by lib/profile.ts ensureTables; here we add the rich onboarding columns.
    await sql`CREATE TABLE IF NOT EXISTS org_profile (org text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now())`;
    await sql`CREATE TABLE IF NOT EXISTS user_profile (email text PRIMARY KEY, org text, created_at timestamptz)`;
    for (const c of [
      `ALTER TABLE org_profile ADD COLUMN IF NOT EXISTS company_type text`,
      `ALTER TABLE org_profile ADD COLUMN IF NOT EXISTS cms_focus text[] DEFAULT '{}'`,
      `ALTER TABLE org_profile ADD COLUMN IF NOT EXISTS track_own_performance boolean DEFAULT false`,
      `ALTER TABLE org_profile ADD COLUMN IF NOT EXISTS provider_name text`,
      `ALTER TABLE org_profile ADD COLUMN IF NOT EXISTS markets text[] DEFAULT '{}'`,
      `ALTER TABLE org_profile ADD COLUMN IF NOT EXISTS company_name text`,
      `ALTER TABLE org_profile ADD COLUMN IF NOT EXISTS website text`,
      `ALTER TABLE org_profile ADD COLUMN IF NOT EXISTS goals text[] DEFAULT '{}'`,
      `ALTER TABLE org_profile ADD COLUMN IF NOT EXISTS targeting jsonb`,
      `ALTER TABLE org_profile ADD COLUMN IF NOT EXISTS technologies jsonb`,
      `ALTER TABLE org_profile ADD COLUMN IF NOT EXISTS monitoring jsonb`,
      `ALTER TABLE org_profile ADD COLUMN IF NOT EXISTS seats int`,
      `ALTER TABLE org_profile ADD COLUMN IF NOT EXISTS seats_pending boolean DEFAULT true`,
      `ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS role text`,
      `ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS delivery jsonb`,
      `ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS onboarding_state jsonb`,
      `ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz`,
      `ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS lead_cadence text`,
      `ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS lead_focus text[] DEFAULT '{}'`,
      `ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS ingestion text`,
      `ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS digest boolean DEFAULT true`,
      `ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS completed_at timestamptz`,
    ]) {
      try { await sql.unsafe(c); } catch (e) { if (!/already exists/i.test((e as Error)?.message || "")) throw e; }
    }
  })().catch((e) => { _ensured = null; throw e; }));
}

const key = (email: string) => email.trim().toLowerCase();

/** Resume: the saved partial state for this user (plus org-level prefill if the company profile exists). */
export async function loadOnboardingState(email: string): Promise<OnboardingState | null> {
  const sql = db();
  try {
    await ensure(sql);
    const e = key(email);
    const [u] = await sql<{ onboarding_state: OnboardingState | null }[]>`
      SELECT onboarding_state FROM user_profile WHERE email = ${e}`;
    if (u?.onboarding_state) return typeof u.onboarding_state === "string" ? JSON.parse(u.onboarding_state as unknown as string) : u.onboarding_state;
    // No saved state — prefill company fields from the org profile if a teammate already created it.
    const [o] = await sql<{ company_name: string | null; website: string | null; company_type: string | null }[]>`
      SELECT company_name, website, company_type FROM org_profile WHERE org = ${orgKey(e)}`;
    if (o) return { stage: 1, goals: [], technologies: [], companyName: o.company_name ?? undefined, website: o.website ?? undefined };
    return null;
  } catch { return null; }
}

/** Save partial progress (resumable). Idempotent upsert of the whole state blob. */
export async function saveOnboardingState(email: string, state: OnboardingState): Promise<void> {
  const sql = db();
  await ensure(sql);
  const e = key(email);
  const payload = JSON.stringify({ ...state, updatedAt: new Date().toISOString() });
  await sql`
    INSERT INTO user_profile (email, org, onboarding_state, created_at)
    VALUES (${e}, ${orgKey(e)}, ${payload}::jsonb, now())
    ON CONFLICT (email) DO UPDATE SET onboarding_state = EXCLUDED.onboarding_state`;
}

/** Commit on "Launch my workspace": write the structured prefs + keep legacy columns in sync. */
export async function completeOnboarding(email: string, state: OnboardingState): Promise<void> {
  const sql = db();
  await ensure(sql);
  const e = key(email);
  const org = orgKey(e);
  const t = state.targeting;
  const wantsTech = ["my_tech_performance", "my_tech_adoption_churn", "fraud_monitoring"].some((g) => state.goals.includes(g as never));
  const anyDigest = ["track_cms", "country_performance", "my_tech_performance", "my_tech_adoption_churn"].some((g) => state.goals.includes(g as never));
  const cadence = state.cmsDigest?.cadence ?? state.techAdoptionChurn?.cadence ?? "weekly";
  const monitoring = state.fraud?.enabled && isFraudEligible(state.companyType) ? { fraud: { enabled: true, status: "pending_setup" } } : {};
  const leadFocus = t?.allPlatforms ? [] : (t?.platforms ?? []);
  const markets = t?.allCountries ? [] : (t?.countries ?? []);

  // Org-level (shared): company profile + targeting defaults + tracked tech + monitoring + seats.
  await sql`
    INSERT INTO org_profile (org, company_name, website, company_type, cms_focus, markets, track_own_performance,
      provider_name, goals, targeting, technologies, monitoring, seats, seats_pending, created_by, created_at)
    VALUES (${org}, ${state.companyName ?? null}, ${state.website ?? null}, ${state.companyType ?? null},
      ${leadFocus}, ${markets}, ${wantsTech}, ${state.technologies[0]?.name ?? null}, ${state.goals},
      ${t ? sql.json(t) : null}, ${sql.json(state.technologies ?? [])}, ${sql.json(monitoring)},
      ${state.seats?.count ?? null}, ${state.seats?.pending ?? true}, ${e}, now())
    ON CONFLICT (org) DO UPDATE SET
      company_name = EXCLUDED.company_name, website = EXCLUDED.website, company_type = EXCLUDED.company_type,
      cms_focus = EXCLUDED.cms_focus, markets = EXCLUDED.markets, track_own_performance = EXCLUDED.track_own_performance,
      provider_name = EXCLUDED.provider_name, goals = EXCLUDED.goals, targeting = EXCLUDED.targeting,
      technologies = EXCLUDED.technologies, monitoring = EXCLUDED.monitoring,
      seats = EXCLUDED.seats, seats_pending = EXCLUDED.seats_pending`;

  // User-level: role + delivery + the legacy digest/lead fields + completion stamps.
  await sql`
    INSERT INTO user_profile (email, org, role, delivery, lead_cadence, lead_focus, ingestion, digest,
      onboarding_state, completed_at, onboarding_completed_at, created_at)
    VALUES (${e}, ${org}, ${state.role ?? null}, ${state.delivery ? sql.json(state.delivery) : null},
      ${cadence}, ${leadFocus}, ${"in_app"}, ${anyDigest}, ${sql.json(state)}, now(), now(), now())
    ON CONFLICT (email) DO UPDATE SET
      role = EXCLUDED.role, delivery = EXCLUDED.delivery, lead_cadence = EXCLUDED.lead_cadence,
      lead_focus = EXCLUDED.lead_focus, ingestion = EXCLUDED.ingestion, digest = EXCLUDED.digest,
      onboarding_state = EXCLUDED.onboarding_state, completed_at = now(), onboarding_completed_at = now()`;
}
