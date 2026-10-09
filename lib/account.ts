/** Account & workspace — the identity layer behind the app shell's account menu and the settings page.
 *
 *  Builds on lib/profile.ts's org model (org = email domain for company inboxes, else the whole email).
 *  Adds an editable display name (user_profile.display_name), an editable workspace name
 *  (org_profile.workspace_name), and a lightweight team roster + pending invites (team_invite).
 *
 *  Billing is intentionally untouched: an invite is CAPTURED as pending — nothing is emailed, no seat
 *  is provisioned, no charge is made. Seat provisioning waits on the billing work (deferred).
 */
import { db as sharedDb } from "./db";
import { orgKey } from "./profile";

function db() { return sharedDb(); }

// Memoised once per process. ALTER TABLE on org_profile / user_profile takes ACCESS EXCLUSIVE, which
// conflicts with the frequent profile reads on the hot path — running it blindly can queue behind
// pipeline traffic and hang the request (see the schema-check-lock note). So we check information_schema
// first (a lock-free read) and only take the exclusive lock when a column/table is genuinely missing,
// under a short lock_timeout so a busy table fails fast instead of blocking the page.
let _ensured: Promise<void> | null = null;
function ensure(sql: ReturnType<typeof db>): Promise<void> {
  return (_ensured ??= (async () => {
    const hasCol = async (table: string, col: string) => {
      const [r] = await sql<{ one: number }[]>`SELECT 1 one FROM information_schema.columns WHERE table_name = ${table} AND column_name = ${col} LIMIT 1`;
      return !!r;
    };
    const hasTable = async (table: string) => {
      const [r] = await sql<{ one: number }[]>`SELECT 1 one FROM information_schema.tables WHERE table_name = ${table} LIMIT 1`;
      return !!r;
    };
    const needName = !(await hasCol("user_profile", "display_name"));
    const needWs = !(await hasCol("org_profile", "workspace_name"));
    const needInvite = !(await hasTable("team_invite"));
    if (!needName && !needWs && !needInvite) return; // common case: nothing to lock.
    await sql.begin(async (t) => {
      await t`SET LOCAL lock_timeout = '3s'`; // never block the request behind a long-held lock.
      if (needName) await t`ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS display_name text`;
      if (needWs) await t`ALTER TABLE org_profile ADD COLUMN IF NOT EXISTS workspace_name text`;
      if (needInvite) await t`CREATE TABLE IF NOT EXISTS team_invite (
        id bigserial PRIMARY KEY,
        org text NOT NULL,
        email text NOT NULL,
        role text NOT NULL DEFAULT 'member',
        status text NOT NULL DEFAULT 'pending',
        invited_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (org, email))`;
    });
  })().catch((e) => { _ensured = null; throw e; }));
}

const key = (email: string) => email.trim().toLowerCase();
const prettify = (s: string) =>
  s.replace(/[._-]+/g, " ").trim().split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") || s;

export function displayNameFor(email: string, stored?: string | null): string {
  return (stored && stored.trim()) || prettify(email.split("@")[0] || email);
}
export function initialsFor(name: string, email: string): string {
  return (name.match(/\b[\p{L}]/gu)?.slice(0, 2).join("") || email[0] || "?").toUpperCase();
}

export type Role = "owner" | "admin" | "member";
export type AccountInfo = {
  email: string;
  displayName: string | null;   // the raw stored value (null = never set)
  name: string;                 // resolved display name (stored, else prettified email)
  initials: string;
  org: string;
  workspace: string;            // resolved workspace name
  workspaceName: string | null; // raw stored value
  domain: string | null;        // the company domain, or null for a personal (generic-inbox) workspace
  isOwner: boolean;
  isCompanyOrg: boolean;        // true when the org is a company domain (team-capable)
};

/** Everything the shell + settings page need about who is signed in and their workspace. */
export async function getAccount(email: string): Promise<AccountInfo> {
  const sql = db();
  const e = key(email);
  const org = orgKey(e);
  const isCompanyOrg = !org.includes("@");
  let displayName: string | null = null;
  let workspaceName: string | null = null;
  let createdBy: string | null = null;
  try {
    await ensure(sql);
    const [u] = await sql<{ display_name: string | null }[]>`SELECT display_name FROM user_profile WHERE email = ${e}`;
    displayName = u?.display_name ?? null;
    const [o] = await sql<{ workspace_name: string | null; created_by: string | null }[]>`SELECT workspace_name, created_by FROM org_profile WHERE org = ${org}`;
    workspaceName = o?.workspace_name ?? null;
    createdBy = o?.created_by ?? null;
  } catch { /* fall back to derived values */ }
  const name = displayNameFor(e, displayName);
  const workspace = (workspaceName && workspaceName.trim()) || (isCompanyOrg ? prettify(org.split(".")[0]) : name);
  const isOwner = !createdBy || createdBy === e;
  return { email: e, displayName, name, initials: initialsFor(name, e), org, workspace, workspaceName, domain: isCompanyOrg ? org : null, isOwner, isCompanyOrg };
}

export async function updateProfile(email: string, displayName: string): Promise<void> {
  const sql = db();
  await ensure(sql);
  const e = key(email);
  const name = displayName.trim().slice(0, 80) || null;
  await sql`
    INSERT INTO user_profile (email, org, display_name) VALUES (${e}, ${orgKey(e)}, ${name})
    ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name`;
}

export async function updateWorkspace(email: string, workspaceName: string): Promise<void> {
  const sql = db();
  await ensure(sql);
  const e = key(email);
  const org = orgKey(e);
  const name = workspaceName.trim().slice(0, 80) || null;
  // Preserve created_by (ownership) on conflict — only the name changes.
  await sql`
    INSERT INTO org_profile (org, workspace_name, created_by) VALUES (${org}, ${name}, ${e})
    ON CONFLICT (org) DO UPDATE SET workspace_name = EXCLUDED.workspace_name`;
}

export type Member = { email: string; name: string; role: Role; you: boolean };

/** The seats currently signed in under this org (one row per user_profile in the org). */
export async function listMembers(email: string): Promise<Member[]> {
  const sql = db();
  const e = key(email);
  const org = orgKey(e);
  let rows: { email: string; display_name: string | null }[] = [];
  let createdBy: string | null = null;
  try {
    await ensure(sql);
    rows = await sql<{ email: string; display_name: string | null }[]>`
      SELECT email, display_name FROM user_profile WHERE org = ${org} ORDER BY created_at NULLS LAST, email`;
    const [o] = await sql<{ created_by: string | null }[]>`SELECT created_by FROM org_profile WHERE org = ${org}`;
    createdBy = o?.created_by ?? null;
  } catch { /* degrade to just the current user below */ }
  if (!rows.some((r) => r.email === e)) rows = [{ email: e, display_name: null }, ...rows];
  const owner = createdBy ?? e;
  return rows.map((r) => ({
    email: r.email,
    name: displayNameFor(r.email, r.display_name),
    role: r.email === owner ? "owner" : "member",
    you: r.email === e,
  }));
}

export type Invite = { id: string; email: string; role: Role; createdAt: string };

export async function listInvites(email: string): Promise<Invite[]> {
  const sql = db();
  const org = orgKey(key(email));
  try {
    await ensure(sql);
    const rows = await sql<{ id: string; email: string; role: Role; created_at: string }[]>`
      SELECT id, email, role, created_at FROM team_invite WHERE org = ${org} AND status = 'pending' ORDER BY created_at DESC`;
    return rows.map((r) => ({ id: String(r.id), email: r.email, role: r.role, createdAt: new Date(r.created_at).toISOString() }));
  } catch { return []; }
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Capture a pending invite. Does NOT send email or provision a seat — that's the (deferred) billing work. */
export async function inviteMember(email: string, inviteEmail: string, role: string): Promise<void> {
  const sql = db();
  await ensure(sql);
  const e = key(email);
  const org = orgKey(e);
  const target = key(inviteEmail);
  if (!EMAIL_RE.test(target)) throw new Error("Enter a valid email address.");
  if (target === e) throw new Error("That's you — you're already on the team.");
  const r: Role = role === "admin" ? "admin" : "member";
  await sql`
    INSERT INTO team_invite (org, email, role, status, invited_by) VALUES (${org}, ${target}, ${r}, 'pending', ${e})
    ON CONFLICT (org, email) DO UPDATE SET role = EXCLUDED.role, status = 'pending', invited_by = EXCLUDED.invited_by, created_at = now()`;
}

export async function cancelInvite(email: string, id: string): Promise<void> {
  const sql = db();
  await ensure(sql);
  const org = orgKey(key(email));
  const idNum = Number(id);
  if (!Number.isFinite(idNum)) return;
  await sql`DELETE FROM team_invite WHERE org = ${org} AND id = ${idNum}`;
}
