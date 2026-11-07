import { redirect } from "next/navigation";
import { currentUser, isAdmin } from "@/lib/auth";
import { getSubscriber, hasAccess, trialDaysLeft } from "@/lib/subscriptions";
import { getAccount } from "@/lib/account";
import { AppShell, type ShellUser } from "@/app/components/app-shell";

// Every authenticated product surface renders inside the shell. The auth + paywall gate lives here
// once (pages inside keep their own guards as defence-in-depth), so a single sign-in check and one
// subscriber read drive the whole frame. Never cached — it's per-user.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const email = await currentUser();
  if (!email) redirect("/login");

  const subscriber = await getSubscriber(email);
  if (!hasAccess(subscriber) && !isAdmin(email)) redirect("/billing");

  const acct = await getAccount(email).catch(() => null);
  const user: ShellUser = acct
    ? { name: acct.name, email: acct.email, workspace: acct.workspace, role: acct.isOwner ? "Owner" : "Member", initials: acct.initials }
    : { name: email.split("@")[0] || email, email, workspace: email, role: "Member", initials: (email[0] || "?").toUpperCase() };
  const billing = { trialDays: trialDaysLeft(subscriber), pastDue: subscriber?.status === "past_due" };

  return <AppShell user={user} billing={billing}>{children}</AppShell>;
}
