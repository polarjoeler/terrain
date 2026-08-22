import Link from "next/link";
import { redirect } from "next/navigation";
import { Wordmark } from "@/app/components/logo";
import { currentUser, isAdmin } from "@/lib/auth";
import { churnReport } from "@/lib/churn";
import { availableCountries } from "@/lib/insights";
import { marketLabel } from "@/lib/markets";
import type { InsightItem } from "@/lib/insights";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Admin · Churn report" };

const usd = (n: number | null) =>
  n == null ? "—" : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n)}`;
const ago = (iso: string) => {
  const d = (Date.now() - new Date(iso).getTime()) / 864e5;
  if (d < 1) return "today";
  if (d < 2) return "yesterday";
  if (d < 30) return `${Math.floor(d)}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};

function BarCard({ title, subtitle, data, tone = "orange" }: { title: string; subtitle?: string; data: InsightItem[]; tone?: string }) {
  const fill = tone === "cyan" ? "bg-cyan" : tone === "mint" ? "bg-mint" : tone === "lilac" ? "bg-lilac" : "bg-orange";
  return (
    <div className="rounded-[2rem] border border-cream/12 bg-cream/[0.03] p-6">
      <h3 className="text-lg font-semibold text-cream">{title}</h3>
      {subtitle && <p className="mt-1 text-xs text-cream/45">{subtitle}</p>}
      <div className="mt-4 space-y-2.5">
        {data.length === 0 && <p className="text-sm text-cream/40">No data yet.</p>}
        {data.slice(0, 8).map((i) => (
          <div key={i.label} className="flex items-center gap-3">
            <div className="w-32 shrink-0 truncate text-sm text-cream/75" title={i.label}>{i.label}</div>
            <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-cream/10">
              <div className={`h-full rounded-full ${fill}`} style={{ width: `${Math.min(i.pct, 100)}%` }} />
            </div>
            <div className="w-8 shrink-0 text-right text-sm tabular-nums text-cream/70">{i.pct}%</div>
            <div className="w-12 shrink-0 text-right text-xs tabular-nums text-cream/40">{i.count.toLocaleString()}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

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
              Every store confirmed dead or migrated off Shopify, snapshotted with what it was using.
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
          <>
            <div className="mt-8 grid gap-4 sm:grid-cols-3 md:grid-cols-5">
              {[
                { n: r.total, l: "total churned" },
                { n: r.dead, l: "dead" },
                { n: r.migrated, l: "migrated off Shopify" },
                { n: r.last30, l: "in last 30 days" },
                { n: r.last90, l: "in last 90 days" },
              ].map((t) => (
                <div key={t.l} className="rounded-3xl border border-cream/12 px-5 py-5">
                  <div className="font-display text-3xl text-cream">{t.n.toLocaleString()}</div>
                  <div className="mt-1 text-xs font-semibold uppercase tracking-wide text-cream/45">{t.l}</div>
                </div>
              ))}
            </div>

            <div className="mt-6 grid gap-5 md:grid-cols-2">
              <BarCard title="Migrated to" subtitle={`Where ${r.migrated.toLocaleString()} stores went`} data={r.byPlatform} tone="cyan" />
              <BarCard title="Categories" subtitle="What churned stores sold" data={r.byCategory} tone="orange" />
              <BarCard title="Payments they used" subtitle="Checkout-verified, where known" data={r.byPayment} tone="mint" />
              <BarCard title="Shipping they used" subtitle="Where known" data={r.byShipping} tone="lilac" />
              <BarCard title="Cities" data={r.byCity} tone="orange" />
              <BarCard title="Themes" data={r.byTheme} tone="mint" />
            </div>

            <div className="mt-6 rounded-[2rem] border border-cream/12 bg-cream/[0.03] p-6">
              <h3 className="text-lg font-semibold text-cream">Recently churned</h3>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-sm text-cream/80">
                  <thead className="text-xs uppercase tracking-wide text-cream/40">
                    <tr>
                      <th className="pb-3 pr-4">Store</th>
                      <th className="pb-3 pr-4">Status</th>
                      <th className="pb-3 pr-4">Churned</th>
                      <th className="pb-3 pr-4">Category</th>
                      <th className="pb-3 pr-4">Est. sales</th>
                      <th className="pb-3">Was using</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.recent.map((c) => (
                      <tr key={c.domain} className="border-t border-cream/10 align-top">
                        <td className="py-3 pr-4">
                          <div className="font-medium text-cream">{c.name ?? c.domain}</div>
                          <span className="font-mono text-xs text-cream/40">{c.domain}</span>
                        </td>
                        <td className="py-3 pr-4">
                          <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${c.status === "migrated" ? "bg-cyan/15 text-cyan" : "bg-orange/15 text-orange"}`}>
                            {c.status === "migrated" ? `→ ${c.migratedTo ?? "other"}` : "dead"}
                          </span>
                        </td>
                        <td className="py-3 pr-4 whitespace-nowrap text-cream/55">{ago(c.churnedAt)}</td>
                        <td className="py-3 pr-4 text-cream/60">{c.category ?? "—"}</td>
                        <td className="py-3 pr-4 whitespace-nowrap">{usd(c.estMonthlySales)}</td>
                        <td className="py-3 text-xs text-cream/55">
                          {[c.payments, c.shipping].filter(Boolean).join(" · ") || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
