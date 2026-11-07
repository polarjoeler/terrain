/** Server persistence for the onboarding profiler. Resumable partial state + a commit-on-launch that
 *  writes the typed, structured preferences — while ALSO keeping the legacy org_profile/user_profile
 *  columns the rest of the app already reads (getOrgProfile, the dashboard persona, dueDigestUsers) in
 *  sync, so nothing downstream breaks.
 *
 *  Onboarding completion (onboarding_completed_at) is tracked SEPARATELY from integration readiness —
 *  a user can finish onboarding while Slack/WhatsApp/fraud setup stays pending.
 */
import { db as sharedDb } from "./db";
import { ensureProfileTables, orgKey } from "./profile";
import type { OnboardingState } from "./onboarding";
import { isFraudEligible } from "./onboarding";

function db() { return sharedDb(); }

// The rich onboarding columns, added on top of the base tables lib/profile.ts creates.
const COLUMNS: [table: "org_profile" | "user_profile", column: string, type: string][] = [
  ["org_profile", "company_type", "text"],
  ["org_profile", "cms_focus", "text[] DEFAULT '{}'"],
  ["org_profile", "track_own_performance", "boolean DEFAULT false"],
  ["org_profile", "provider_name", "text"],
  ["org_profile", "markets", "text[] DEFAULT '{}'"],
  ["org_profile", "company_name", "text"],
  ["org_profile", "website", "text"],
  ["org_profile", "goals", "text[] DEFAULT '{}'"],
  ["org_profile", "targeting", "jsonb"],
  ["org_profile", "technologies", "jsonb"],
  ["org_profile", "monitoring", "jsonb"],
  ["org_profile", "seats", "int"],
  ["org_profile", "seats_pending", "boolean DEFAULT true"],
  ["org_profile", "created_by", "text"],
  ["user_profile", "role", "text"],
  ["user_profile", "delivery", "jsonb"],
  ["user_profile", "onboarding_state", "jsonb"],
  ["user_profile", "onboarding_completed_at", "timestamptz"],
  ["user_profile", "lead_cadence", "text"],
  ["user_profile", "lead_focus", "text[] DEFAULT '{}'"],
  ["user_profile", "ingestion", "text"],
  ["user_profile", "digest", "boolean DEFAULT true"],
  ["user_profile", "completed_at", "timestamptz"],
  ["user_profile", "created_at", "timestamptz"],
];

// Same rule as lib/profile.ts ensureTables: a module memo is per LAMBDA INSTANCE, and every
// ADD COLUMN IF NOT EXISTS takes ACCESS EXCLUSIVE before checking, so replaying ~25 of them on each
// cold start is the lock-jam class. Read the catalog (no table lock) and alter only what's missing —
// normally nothing. The base tables come from lib/profile.ts; if they don't exist yet, create them
// through it rather than racing it with a second CREATE.
let _ensured: Promise<void> | null = null;
function ensure(sql: ReturnType<typeof db>): Promise<void> {
  return (_ensured ??= (async () => {
    let rows = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('org_profile','user_profile')`;
    if (!rows.some((r) => r.table_name === "org_profile") || !rows.some((r) => r.table_name === "user_profile")) {
      await ensureProfileTables();
      rows = await sql<{ table_name: string; column_name: string }[]>`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name IN ('org_profile','user_profile')`;
    }
    const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
    for (const [t, c, type] of COLUMNS) {
      if (!have.has(`${t}.${c}`)) await sql.unsafe(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${c} ${type}`);
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
  const wantsTech = ["my_tech_performance", "fraud_monitoring"].some((g) => state.goals.includes(g as never));
  const anyDigest = ["track_cms", "country_performance", "my_tech_performance"].some((g) => state.goals.includes(g as never));
  const cadence = state.cmsDigest?.cadence ?? state.techDeepDive?.cadence ?? "weekly";
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
