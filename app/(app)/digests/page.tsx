import { currentUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getFocus, getUserProfile } from "@/lib/profile";
import { focusPhrase, hasTargeting, type Focus } from "@/lib/focus";
import { marketLabel } from "@/lib/markets";
import { getAccount } from "@/lib/account";
import { DigestsManager } from "./digests-manager";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Digests" };

type Item = { title: string; desc: string };

/** What THIS user's email actually contains — derived from their focus (lib/focus), section for
 *  section the way lib/digest builds it. Only list what the email really sends. */
function contentsFor(focus: Focus): Item[] {
  const phrase = hasTargeting(focus) ? focusPhrase(focus) : "stores";
  const items: Item[] = [
    { title: `3 ${phrase} worth your attention`, desc: hasTargeting(focus)
      ? "Picked from this week's new stores in your focus — confirmed matches first, then ones we can't size yet — ranked by size, contacts and checkout."
      : "Picked from this week's new stores across the market, ranked by size, contacts and checkout." },
    { title: `How many new ${phrase} arrived`, desc: "The week's count, how many have a contact email, and which provider leads checkout." },
  ];
  if (focus.countries.length && focus.countries.length <= 4) {
    items.push({ title: "Your markets", desc: `New stores this week in ${focus.countries.map((c) => marketLabel(c).replace(/^[^\p{L}]+/u, "")).join(", ")}.` });
  }
  for (const t of focus.technologies.slice(0, 2)) {
    items.push({ title: `Your tech: ${t.name}`, desc: `How often ${t.name} shows up on the new stores we've scanned this week.` });
  }
  items.push({ title: "Market movers", desc: "The week's top theme and most-installed app." });
  return items;
}

export default async function DigestsPage() {
  const email = await currentUser();
  if (!email) redirect("/login");

  const profile = await getUserProfile(email).catch(() => null);
  const account = await getAccount(email).catch(() => null);
  const focus = await getFocus(email);

  const subscribed = !!profile?.digest;
  const cadence = profile?.leadCadence ?? "weekly";

  return (
    <DigestsManager
      subscribed={subscribed}
      cadence={cadence}
      email={account?.email ?? email}
      workspace={account?.workspace ?? "your workspace"}
      contents={contentsFor(focus)}
      focusPhrase={hasTargeting(focus) ? focusPhrase(focus) : null}
    />
  );
}
