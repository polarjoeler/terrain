import { redirect } from "next/navigation";
import { currentUser, isAdmin } from "@/lib/auth";
import { getSubscriber, hasAccess, trialDaysLeft } from "@/lib/subscriptions";
import { getOrgProfile, orgKey } from "@/lib/profile";
import { AppShell, type ShellUser } from "@/app/components/app-shell";

// Every authenticated product surface renders inside the shell. The auth + paywall gate lives here
// once (pages inside keep their own guards as defence-in-depth), so a single sign-in check and one
// subscriber read drive the whole frame. Never cached — it's per-user.
export const dynamic = "force-dynamic";

// company_type → a human role label for the account chip (best-effort until the real identity
// system lands; see the account/workspace brief).
const ROLE_LABEL: Record<string, string> = {
  payments: "Payments", app_developer: "App developer", investor: "Investor",
  researcher: "Researcher", shipping: "Shipping & logistics", agency: "Agency", other: "Member",
};

// Title-case a slug/handle: "paystack" → "Paystack", "jane.doe" → "Jane Doe".
const prettify = (s: string) =>
  s.replace(/[._-]+/g, " ").trim().split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") || s;

function deriveUser(email: string, companyType?: string): ShellUser {
  const org = orgKey(email);
  const local = email.split("@")[0] || email;
  // Workspace = the company (domain SLD) for company inboxes; the person otherwise.
  const workspace = org.includes("@") ? prettify(local) : prettify(org.split(".")[0]);
  const name = prettify(local);
  const initials = (name.match(/\b[A-Za-z]/g)?.slice(0, 2).join("") || email[0] || "?").toUpperCase();
  const role = companyType ? (ROLE_LABEL[companyType] ?? "Member") : "Member";
  return { name, email, workspace, role, initials };
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const email = await currentUser();
  if (!email) redirect("/login");

  const subscriber = await getSubscriber(email);
  if (!hasAccess(subscriber) && !isAdmin(email)) redirect("/billing");

  const org = await getOrgProfile(orgKey(email)).catch(() => null);
  const user = deriveUser(email, org?.companyType);
  const billing = { trialDays: trialDaysLeft(subscriber), pastDue: subscriber?.status === "past_due" };

  return <AppShell user={user} billing={billing}>{children}</AppShell>;
}
