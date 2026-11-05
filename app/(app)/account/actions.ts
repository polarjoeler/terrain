"use server";

import { currentUser } from "@/lib/auth";
import { getAccount, updateProfile, updateWorkspace, inviteMember, cancelInvite } from "@/lib/account";
import { getSubscriber, upsertSubscriber } from "@/lib/subscriptions";
import { normaliseSeats, setSeatQuantity } from "@/lib/stripe";
import { planOf } from "@/lib/plans";
import { seatRoster } from "@/lib/seats";

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

/** Change the paid extra-seat count on the workspace's live subscription.
 *
 *  Only the address that PAYS may do this: a seat holder reads the owner's record (it comes back
 *  with `viaSeat` set), and acting on it would let a teammate raise someone else's bill.
 *
 *  Writes the new count locally as well as to Stripe. The webhook will set the same value when
 *  `customer.subscription.updated` arrives, but the page refreshes immediately after this returns
 *  and would otherwise show the old number for as long as the round trip takes. */
export async function setSeatsAction(extraSeats: number): Promise<Result> {
  const email = await currentUser();
  if (!email) return { ok: false, error: "Please sign in again." };

  const sub = await getSubscriber(email).catch(() => null);
  if (!sub) return { ok: false, error: "No subscription on this account yet." };
  if (sub.viaSeat) return { ok: false, error: "Only the workspace owner can change seats." };
  if (!sub.subscriptionCode) {
    return { ok: false, error: "Seats are added to a live subscription — start one on the billing page first." };
  }

  const seats = normaliseSeats(extraSeats);
  // Don't let a reduction silently cut off teammates who are already using a seat.
  const org = (await getAccount(email).catch(() => null))?.org;
  if (org) {
    const held = (await seatRoster(org).catch(() => [])).length;
    const capacity = planOf(sub.plan).seats + seats;
    if (capacity < held + 1) {
      return {
        ok: false,
        error: `${held} teammate${held === 1 ? " is" : "s are"} using a seat. Remove ${held + 1 - capacity} from the team first.`,
      };
    }
  }

  try {
    const applied = await setSeatQuantity(sub.subscriptionCode, seats);
    await upsertSubscriber(email, { extraSeats: applied });
    return { ok: true };
  } catch (e) {
    console.error(`[terrain] seat change failed for ${email}:`, e);
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't update seats — please try again." };
  }
}
