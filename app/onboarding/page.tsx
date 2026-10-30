import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { orgHasProfile, orgKey } from "@/lib/profile";
import { loadOnboardingState } from "@/lib/onboarding-store";
import { cachedAgg } from "@/lib/agg-cache";
import { db } from "@/lib/db";
import { PLATFORMS } from "@/lib/platforms";
import { FOCUS_MARKETS, marketLabel } from "@/lib/markets";
import { OnboardingFlow } from "./onboarding-flow";
import type { OnboardingState } from "@/lib/onboarding";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Set up your workspace" };

// The searchable category list is DATA-DERIVED (no canonical taxonomy) — the most common real
// categories, cached so onboarding never waits on a scan.
async function topCategories(): Promise<string[]> {
  return cachedAgg("onboarding:categories", 6 * 60 * 60 * 1000, async () => {
    const sql = db();
    const rows = await sql<{ category: string }[]>`
      SELECT category FROM imported_stores
      WHERE published AND category IS NOT NULL AND category <> '' AND country = ANY(ARRAY['ZA','KE','NG'])
      GROUP BY category ORDER BY count(*) DESC LIMIT 60`.catch(() => []);
    return rows.map((r) => r.category);
  }).catch(() => []);
}

export default async function OnboardingPage() {
  const email = await currentUser();
  if (!email) redirect("/login");

  const [firstUser, saved, categories] = await Promise.all([
    orgHasProfile(email).then((has) => !has).catch(() => true),
    loadOnboardingState(email).catch((): OnboardingState | null => null),
    topCategories(),
  ]);

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
        orgName={orgName}
        initialState={saved}
        platforms={platforms}
        categories={categories}
        markets={markets}
      />
    </main>
  );
}
