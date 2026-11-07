"use server";

import { currentUser } from "@/lib/auth";
import { getAccount, updateProfile, updateWorkspace, inviteMember, cancelInvite } from "@/lib/account";

type Result = { ok: true } | { ok: false; error: string };

export async function saveProfileAction(displayName: string): Promise<Result> {
  const email = await currentUser();
  if (!email) return { ok: false, error: "Please sign in again." };
  try {
    await updateProfile(email, displayName);
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't save — please try again." };
  }
}

export async function saveWorkspaceAction(workspaceName: string): Promise<Result> {
  const email = await currentUser();
  if (!email) return { ok: false, error: "Please sign in again." };
  // Only the workspace owner may rename it.
  const acct = await getAccount(email).catch(() => null);
  if (!acct?.isOwner) return { ok: false, error: "Only the workspace owner can rename it." };
  try {
    await updateWorkspace(email, workspaceName);
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't save — please try again." };
  }
}

export async function inviteMemberAction(inviteEmail: string, role: string): Promise<Result> {
  const email = await currentUser();
  if (!email) return { ok: false, error: "Please sign in again." };
  const acct = await getAccount(email).catch(() => null);
  if (!acct?.isCompanyOrg) return { ok: false, error: "Team invites are available on company workspaces." };
  try {
    await inviteMember(email, inviteEmail, role);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't save the invite." };
  }
}

export async function cancelInviteAction(id: string): Promise<Result> {
  const email = await currentUser();
  if (!email) return { ok: false, error: "Please sign in again." };
  try {
    await cancelInvite(email, id);
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't cancel — please try again." };
  }
}
