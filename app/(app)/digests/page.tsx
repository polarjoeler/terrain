import { currentUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getUserProfile, getOrgProfile, orgKey } from "@/lib/profile";
import { getAccount } from "@/lib/account";
import { DigestsManager } from "./digests-manager";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Digests" };

type Item = { title: string; desc: string };

// What a given persona gets in their briefing. Everyone gets the base market movement; some company
// types get an extra, more specific signal on top.
const BASE: Item[] = [
  { title: "New stores in your markets", desc: "Fresh launches by country and platform, the week they appear." },
  { title: "Platform migrations", desc: "Stores that moved onto (or off) Shopify, WooCommerce and the rest." },
  { title: "Shopify Plus upgrades", desc: "Merchants that stepped up to Plus — your highest-value signals." },
  { title: "Payment & checkout shifts", desc: "Providers added or dropped at checkout across the market." },
  { title: "Store churn", desc: "Stores that went dark — stopped selling or disappeared." },
];
const EXTRA: Record<string, Item> = {
  payments: { title: "Stores with no provider yet", desc: "New merchants that haven't wired up a gateway — prime outreach." },
  shipping: { title: "Carrier wins & losses", desc: "Which couriers are winning at checkout in your markets." },
  app_developer: { title: "App adoption gaps", desc: "Where merchants are installing — and where the gaps are for your app." },
  agency: { title: "Partner movement", desc: "Agencies and service partners active around your target stores." },
  investor: { title: "Market growth signals", desc: "Launch and churn trends shaping where the market is heading." },
};

export default async function DigestsPage() {
  const email = await currentUser();
  if (!email) redirect("/login");

  const profile = await getUserProfile(email).catch(() => null);
  const org = await getOrgProfile(orgKey(email)).catch(() => null);
  const account = await getAccount(email).catch(() => null);

  const subscribed = !!profile?.digest;
  const cadence = profile?.leadCadence ?? "weekly";
  const extra = org?.companyType ? EXTRA[org.companyType] : undefined;
  const contents = extra ? [extra, ...BASE] : BASE;

  return (
    <DigestsManager
      subscribed={subscribed}
      cadence={cadence}
      email={account?.email ?? email}
      workspace={account?.workspace ?? "your workspace"}
      contents={contents}
    />
  );
}
