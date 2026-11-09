import Link from "next/link";
import { redirect } from "next/navigation";
import { Wordmark } from "@/app/components/logo";
import { currentUser, isAdmin } from "@/lib/auth";
import { PROVIDERS, listConnections } from "@/lib/integrations";
import { tagCounts } from "@/lib/tags";
import { availableCountries } from "@/lib/insights";
import { outreachCounts, OUTREACH_MARKETS } from "@/lib/imported";
import { ConnectionsPanel } from "@/app/components/connections-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Admin · Integrations" };

/** The admin view of the same panel customers use at /connections — plus the curated cohort tags,
 *  and unmetered (admins pass no allowance, so no ceiling but the provider's own). Keeping both on
 *  one component means the push customers get is the push we test here. */
export default async function AdminIntegrations() {
  const email = await currentUser();
  if (!email) redirect("/login");
  if (!isAdmin(email)) redirect("/dashboard");

  const [connections, cohorts, countries, counts] = await Promise.all([
    listConnections(email).catch(() => []),
    tagCounts().catch(() => []),
    availableCountries().catch(() => []),
    outreachCounts().catch(() => ({ reachable: 0, all: 0 })),
  ]);

  // Offer only the markets a push can reach (see OUTREACH_MARKETS).
  const markets = countries.filter((c) => OUTREACH_MARKETS.includes(c.country));

  return (
    <div className="min-h-screen px-4 py-6 md:px-8">
      <div className="mx-auto max-w-3xl">
        <nav className="flex items-center justify-between">
          <Link href="/"><Wordmark size="text-xl" /></Link>
          <div className="flex items-center gap-3 text-sm">
            <Link href="/admin" className="text-cream/60 hover:text-cream">← Admin</Link>
            <span className="rounded-full border border-orange/30 bg-orange/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-orange">Admin</span>
          </div>
        </nav>

        <header className="mt-10">
          <h1 className="font-display text-4xl md:text-5xl">Integrations</h1>
          <p className="mt-2 text-cream/60">
            Connect an outreach tool, then push a cohort of contactable leads straight into a
            campaign. Keys are stored encrypted; only contactable stores (with an email) are pushed.
          </p>
        </header>

        <ConnectionsPanel
          providers={PROVIDERS}
          connected={connections.map((c) => ({ provider: c.provider, config: c.config }))}
          countries={markets}
          cohorts={cohorts.filter((c) => c.count > 0)}
          allowance={null}
          initialCounts={counts}
        />
      </div>
    </div>
  );
}
