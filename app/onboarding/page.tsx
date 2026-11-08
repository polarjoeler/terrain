import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { orgHasProfile, orgKey } from "@/lib/profile";
import { loadOnboardingState } from "@/lib/onboarding-store";
import { getSubscriber } from "@/lib/subscriptions";
import { planOf, EXTRA_SEAT_USD } from "@/lib/plans";
import { cachedAgg } from "@/lib/agg-cache";
import { db } from "@/lib/db";
import { PLATFORMS } from "@/lib/platforms";
import { FOCUS_MARKETS, marketLabel } from "@/lib/markets";
import { OnboardingFlow } from "./onboarding-flow";
import type { OnboardingState } from "@/lib/onboarding";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Set up your workspace" };

// The searchable category list is DATA-DERIVED (no canonical taxonomy) — the most common real
// categories, cached so onboarding never waits on a scan (~20s cold; SWR, so only the first-ever
// request pays it). "Other"/"Unknown" are classifier leftovers, not something to target.
async function topCategories(): Promise<string[]> {
  return cachedAgg("onboarding:categories:v2", 24 * 60 * 60 * 1000, async () => {
    const sql = db();
    const rows = await sql<{ category: string }[]>`
      SELECT category FROM imported_stores
      WHERE published AND category IS NOT NULL AND category NOT IN ('', 'Other', 'Unknown') AND country = ANY(ARRAY['ZA','KE','NG'])
      GROUP BY category ORDER BY count(*) DESC LIMIT 60`.catch(() => []);
    return rows.map((r) => r.category);
  }).catch(() => []);
}

export default async function OnboardingPage() {
  const email = await currentUser();
  if (!email) redirect("/login");

  // Sequential, not Promise.all: three queries fanned out on the small pool is the deadlock class.
  const firstUser = await orgHasProfile(email).then((has) => !has).catch(() => true);
  const saved = await loadOnboardingState(email).catch((): OnboardingState | null => null);
  const categories = await topCategories();
  // Seats are real and purchasable (#104), so stage 5 quotes the plan's own allowance and the
  // live per-seat price rather than telling people billing isn't set up. lib/plans stays the
  // single source of truth for both.
  const sub = await getSubscriber(email).catch(() => null);
  const seatInfo = sub
    ? { planLabel: planOf(sub.plan).label, included: planOf(sub.plan).seats, extraUsd: EXTRA_SEAT_USD }
    : null;

  const org = orgKey(email);
  const orgName = org.includes("@") ? "" : org;
  // Customer-visible platforms first, then the rest we track — so the taxonomy is complete but led by launched ones.
  const platforms = [
    ...PLATFORMS.filter((p) => p.customerVisible),
    ...PLATFORMS.filter((p) => !p.customerVisible),
  ].map((p) => ({ id: p.id, label: p.label }));
  const markets = FOCUS_MARKETS.map((iso) => ({ iso, label: marketLabel(iso) }));

  return (
    <main className="min-h-screen bg-ink">
      <OnboardingFlow
        email={email}
        firstUser={firstUser}
        seatInfo={seatInfo}
        orgName={orgName}
        initialState={saved}
        platforms={platforms}
        categories={categories}
        markets={markets}
      />
    </main>
  );
}
