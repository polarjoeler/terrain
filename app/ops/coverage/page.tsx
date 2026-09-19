import { Fragment } from "react";
import { redirect } from "next/navigation";
import Link from "next/link";
import { currentUser, isAdmin } from "@/lib/auth";
import { coverageMatrix, type PlatCoverage } from "@/lib/ops";
import { marketLabel } from "@/lib/markets";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Coverage" };

const SHOP = "#95BF47", WOO = "#96588a";

// A coverage cell: a small bar + the %, colour-coded per metric.
function Cov({ pct, tone }: { pct: number; tone: string }) {
  const c = tone === "mint" ? "bg-mint" : tone === "cyan" ? "bg-cyan" : "bg-lilac";
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="h-1.5 w-10 overflow-hidden rounded-full bg-cream/10">
        <div className={`h-full rounded-full ${c}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <span className="w-8 text-right text-xs tabular-nums text-cream/70">{pct}%</span>
    </div>
  );
}

function PlatRow({ country, label, color, p, focus }: { country: string; label: string; color: string; p: PlatCoverage; focus: boolean }) {
  return (
    <tr className={`border-b border-cream/[0.06] ${focus ? "bg-cream/[0.03]" : ""}`}>
      <td className="py-2.5 pl-3 pr-2">
        <span className="text-sm text-cream/85">{marketLabel(country)}</span>
        {focus && <span className="ml-2 rounded-full border border-mint/25 bg-mint/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-mint">focus</span>}
      </td>
      <td className="py-2.5 pr-2">
        <span className="flex items-center gap-1.5 text-xs text-cream/70"><span className="h-2 w-2 rounded-full" style={{ background: color }} />{label}</span>
      </td>
      <td className="py-2.5 pr-3 text-right font-display text-base tabular-nums text-cream">{p.total.toLocaleString()}</td>
      <td className="py-2.5 pr-3 text-right text-xs tabular-nums text-cream/45">{p.live.toLocaleString()}</td>
      <td className="py-2.5 pr-3"><Cov pct={p.payPct} tone="mint" /></td>
      <td className="py-2.5 pr-3"><Cov pct={p.launchPct} tone="cyan" /></td>
      <td className="py-2.5 pr-3"><Cov pct={p.checkedPct} tone="lilac" /></td>
    </tr>
  );
}

export default async function CoveragePage() {
  const email = await currentUser();
  if (!email) redirect("/login");
  if (!isAdmin(email)) redirect("/dashboard");

  const m = await coverageMatrix().catch(() => null);
  if (!m) return <main className="grid min-h-screen place-items-center text-cream/50">Couldn&rsquo;t load coverage.</main>;

  const focus = m.rows.filter((r) => r.focus);
  const rest = m.rows.filter((r) => !r.focus);
  const grandTotal = m.grand.shopify.total + m.grand.woo.total;

  const GrandCard = ({ label, color, p }: { label: string; color: string; p: PlatCoverage }) => (
    <div className="rounded-2xl border border-cream/12 bg-cream/[0.02] p-4">
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
        <span className="text-sm font-semibold text-cream">{label}</span>
        <span className="ml-auto font-display text-2xl tabular-nums text-cream">{p.total.toLocaleString()}</span>
      </div>
      <div className="mt-3 space-y-2">
        {[["Payments", p.payPct, "mint"], ["Launch date", p.launchPct, "cyan"], ["Liveness checked", p.checkedPct, "lilac"]].map(([l, v, t]) => (
          <div key={l as string} className="flex items-center gap-2 text-[11px] text-cream/50">
            <span className="w-24">{l}</span>
            <Cov pct={v as number} tone={t as string} />
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <main className="min-h-screen px-4 py-6">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-display text-2xl text-cream">Enrichment Coverage</h1>
            <p className="mt-1 text-xs text-cream/40">{grandTotal.toLocaleString()} stores · {m.totalCountries} countries · what we hold and how enriched it is, by country &amp; platform</p>
          </div>
          <Link href="/ops" className="rounded-full border border-cream/15 px-3 py-1 text-sm text-cream/60 hover:text-cream">← Ops</Link>
        </div>

        {/* Grand totals per platform */}
        <section className="mt-5 grid gap-3 sm:grid-cols-2">
          <GrandCard label="Shopify" color={SHOP} p={m.grand.shopify} />
          <GrandCard label="WooCommerce" color={WOO} p={m.grand.woo} />
        </section>

        <p className="mt-4 text-[11px] text-cream/35">
          Focus markets (ZA · KE · NG · JP) are the ones we actively enrich; the rest of the world is discovered &amp; banked but only lightly enriched.
          Coverage is % of stores in that country/platform with payments verified · a real launch date · a liveness check on record.
        </p>

        {/* Matrix */}
        <section className="mt-4 overflow-x-auto rounded-3xl border border-cream/12 bg-cream/[0.02]">
          <table className="w-full min-w-[640px] border-collapse">
            <thead>
              <tr className="border-b border-cream/12 text-[10px] font-semibold uppercase tracking-wide text-cream/40">
                <th className="py-2.5 pl-3 pr-2 text-left">Country</th>
                <th className="py-2.5 pr-2 text-left">Platform</th>
                <th className="py-2.5 pr-3 text-right">Stores</th>
                <th className="py-2.5 pr-3 text-right">Live</th>
                <th className="py-2.5 pr-3 text-right">Payments</th>
                <th className="py-2.5 pr-3 text-right">Launch</th>
                <th className="py-2.5 pr-3 text-right">Liveness</th>
              </tr>
            </thead>
            <tbody>
              {[...focus, ...rest].map((r) => (
                <Fragment key={r.country}>
                  {r.shopify && <PlatRow country={r.country} label="Shopify" color={SHOP} p={r.shopify} focus={r.focus} />}
                  {r.woo && <PlatRow country={r.country} label="Woo" color={WOO} p={r.woo} focus={r.focus} />}
                </Fragment>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </main>
  );
}
