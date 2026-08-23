import Link from "next/link";
import { redirect } from "next/navigation";
import { Wordmark } from "@/app/components/logo";
import { currentUser, isAdmin } from "@/lib/auth";
import { churnReport } from "@/lib/churn";
import { availableCountries } from "@/lib/insights";
import { marketLabel } from "@/lib/markets";
import { ChurnView } from "./churn-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Admin · Churn report" };

export default async function ChurnReport({ searchParams }: { searchParams: Promise<{ country?: string }> }) {
  const email = await currentUser();
  if (!email) redirect("/login");
  if (!isAdmin(email)) redirect("/dashboard");

  const countries = await availableCountries().catch(() => []);
  const sp = await searchParams;
  const country = sp.country && countries.some((c) => c.country === sp.country) ? sp.country : undefined;
  const r = await churnReport(country).catch(() => null);

  return (
    <div className="min-h-screen px-4 py-6 md:px-8">
      <div className="mx-auto max-w-5xl">
        <nav className="flex items-center justify-between">
          <Link href="/"><Wordmark size="text-xl" /></Link>
          <div className="flex items-center gap-3 text-sm">
            <Link href="/admin" className="text-cream/60 hover:text-cream">← Admin</Link>
            <Link href="/insights" className="text-cream/60 hover:text-cream">Insights →</Link>
            <span className="rounded-full border border-orange/30 bg-orange/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-orange">Admin</span>
          </div>
        </nav>

        <header className="mt-10 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-4xl md:text-5xl">Churn report</h1>
            <p className="mt-2 max-w-xl text-cream/60">
              Real churn — stores we confirmed live that later died or migrated off Shopify,
              snapshotted with what they were using. Already-dead imported sites are kept
              separate as historic die-off.
            </p>
          </div>
          {countries.length > 1 && (
            <div className="flex flex-wrap gap-2">
              <Link href="/admin/churn" className={`rounded-full px-3.5 py-1.5 text-sm ${!country ? "bg-cream text-ink" : "border border-cream/15 text-cream/60"}`}>All markets</Link>
              {countries.map((c) => (
                <Link key={c.country} href={`/admin/churn?country=${c.country}`} className={`rounded-full px-3.5 py-1.5 text-sm ${country === c.country ? "bg-cream text-ink" : "border border-cream/15 text-cream/60"}`}>{marketLabel(c.country)}</Link>
              ))}
            </div>
          )}
        </header>

        {!r ? (
          <p className="mt-10 text-cream/50">No churn data yet.</p>
        ) : (
          <ChurnView report={r} />
        )}
      </div>
    </div>
  );
}
