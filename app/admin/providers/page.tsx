import Link from "next/link";
import { redirect } from "next/navigation";
import { Wordmark } from "@/app/components/logo";
import { currentUser, isAdmin } from "@/lib/auth";
import { availableProviders } from "@/lib/provider-insights";
import { signProviderToken } from "@/lib/provider-share";
import { providerSlug } from "@/lib/provider-slug";
import { classify } from "@/lib/payments-taxonomy";
import { ProvidersView, type ProviderRow } from "./providers-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Admin · Provider reports" };

export default async function ProviderReports() {
  const email = await currentUser();
  if (!email) redirect("/login");
  if (!isAdmin(email)) redirect("/dashboard");

  // Every gateway we have checkout-verified data for gets a report — the page at
  // /p/<slug> is provider-generic, so this list IS the set of live reports.
  const providers = await availableProviders(1).catch(() => []);

  // Signing needs AUTH_SECRET; without it the reports still open for an admin,
  // they just can't be shared, so degrade rather than 500 the whole page.
  let canShare = true;
  const tokenFor = (p: string) => {
    if (!canShare) return "";
    try { return signProviderToken(p); } catch { canShare = false; return ""; }
  };

  // availableProviders already canonicalises labels and drops non-providers, so
  // every row here is a real gateway worth its own report.
  const rows: ProviderRow[] = providers
    .map((p) => ({
      provider: p.provider,
      stores: p.stores,
      type: classify(p.provider),
      slug: providerSlug(p.provider),
      token: tokenFor(p.provider),
    }));

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

        <header className="mt-10">
          <h1 className="font-display text-4xl md:text-5xl">Provider reports</h1>
          <p className="mt-2 max-w-2xl text-cream/60">
            Every payment gateway we have checkout-verified data on has its own market
            report. Copy a share link to give that company read-only access to their own
            page — no login, and it grants nothing but that one provider.
          </p>
        </header>

        {!canShare && (
          <p className="mt-6 rounded-2xl border border-orange/30 bg-orange/10 px-4 py-3 text-sm text-orange">
            AUTH_SECRET isn&apos;t set, so share links can&apos;t be signed. Reports still open for you as an admin.
          </p>
        )}

        {rows.length === 0 ? (
          <p className="mt-10 text-cream/50">No checkout-verified payment data yet.</p>
        ) : (
          <ProvidersView rows={rows} />
        )}
      </div>
    </div>
  );
}
