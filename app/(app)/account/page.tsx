import { currentUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getAccount, listMembers, listInvites } from "@/lib/account";
import { getSubscriber } from "@/lib/subscriptions";
import { AccountSettings } from "./account-settings";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Account & workspace" };

const PLAN_LABEL: Record<string, string> = { starter: "Starter", pro: "Pro" };
const STATUS_LABEL: Record<string, string> = {
  trialing: "Trial", active: "Active", past_due: "Payment due", cancelled: "Cancelled", expired: "Expired",
};

export default async function AccountPage() {
  const email = await currentUser();
  if (!email) redirect("/login");

  // Sequential (never fan out on the small pool).
  const account = await getAccount(email);
  const members = await listMembers(email).catch(() => []);
  const invites = account.isCompanyOrg ? await listInvites(email).catch(() => []) : [];
  const sub = await getSubscriber(email).catch(() => null);
  const plan = sub ? { label: PLAN_LABEL[sub.plan] ?? sub.plan, status: STATUS_LABEL[sub.status] ?? sub.status } : null;

  return <AccountSettings account={account} members={members} invites={invites} plan={plan} />;
}
