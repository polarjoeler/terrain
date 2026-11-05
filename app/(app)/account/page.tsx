import { currentUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getAccount, listMembers, listInvites } from "@/lib/account";
import { getSubscriber, orgSeats, usageFor } from "@/lib/subscriptions";
import { AccountSettings } from "./account-settings";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Account & workspace" };

const STATUS_LABEL: Record<string, string> = {
  trialing: "Trial", active: "Active", past_due: "Payment due", cancelled: "Cancelled", expired: "Expired",
};

export default async function AccountPage() {
  const email = await currentUser();
  if (!email) redirect("/login");

  // Sequential (never fan out on the small pool).
  const account = await getAccount(email);
  const members = await listMembers(email).catch(() => []);
  // Seat-holding invites, minus anyone already listed as a member (they'd appear twice).
  const allInvites = account.isCompanyOrg ? await listInvites(email).catch(() => []) : [];
  const invites = allInvites.filter((i) => !members.some((m) => m.email === i.email));
  const sub = await getSubscriber(email).catch(() => null);
  // usageFor resolves the plan (including the legacy starter|pro values still in the DB),
  // so the label, the allowance and the month's usage all come from one place.
  const u = usageFor(sub);
  const plan = sub
    ? { label: u.plan.label, status: STATUS_LABEL[sub.status] ?? sub.status, used: u.used, limit: u.limit, remaining: u.remaining }
    : null;
  const s = await orgSeats(account.org).catch(() => null);
  const seats = s && {
    capacity: s.capacity,
    used: s.used,
    extraSeats: s.extraSeats,
    included: u.plan.seats,
    seatUsd: u.plan.extraSeatUsd,
    // Seats are changed on the live Stripe subscription, so they can only be managed by the
    // address that pays (a seat holder's record carries `viaSeat`) and only once one exists —
    // an admin-granted trial has no subscription to add an item to.
    canManage: !!sub && !sub.viaSeat && !!sub.subscriptionCode,
    viaSeat: sub?.viaSeat ?? null,
  };

  return <AccountSettings account={account} members={members} invites={invites} plan={plan} seats={seats} />;
}
