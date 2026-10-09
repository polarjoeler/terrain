import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { platformReport, REGIONS, cmsLabel } from "@/lib/platforms-report";
import { FOCUS_MARKETS, marketLabel, marketFlag } from "@/lib/markets";
import { InsightsNav } from "../insights-nav";
import { LaunchTrend } from "@/app/components/command";
import { PlatformFilters } from "./platforms-filters";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Platform share & growth" };

const cleanMarket = (iso: string) => marketLabel(iso).replace(/^[^\p{L}]+/u, "");
const CMS_OPTS = ["shopify", "woocommerce", "wix", "squarespace", "magento", "prestashop", "bigcommerce", "ec-cube", "base", "cafe24"].map((v) => ({ value: v, label: cmsLabel(v) }));
const EXTRA_COUNTRIES = ["US", "GB", "DE", "FR", "AU", "CA", "BR", "IN", "SG", "AE"];

export default async function PlatformsPage({ searchParams }: { searchParams: Promise<{ region?: string; country?: string; cms?: string }> }) {
  if (!(await currentUser())) redirect("/login");
  const sp = await searchParams;
  const report = await platformReport({ region: sp.region, country: sp.country, cms: sp.cms });
  const { share, migrations, trend, coverage, scopeLabel } = report;

  const regionOpts = Object.entries(REGIONS).map(([value, r]) => ({ value, label: r.label }));
  const countryOpts = [
    ...[...FOCUS_MARKETS].map((c) => ({ value: c, label: cleanMarket(c) })),
    ...EXTRA_COUNTRIES.map((c) => ({ value: c, label: c })),
  ];
  const shareMax = Math.max(1, ...share.map((s) => s.live));
  const winner = share[0];
  const migMovers = migrations.filter((m) => m.net !== 0 && (m.joined + m.left) >= 3).slice(0, 8);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <InsightsNav active="Platforms" />
        <span className="shrink-0 rounded-full border border-mint/25 bg-mint/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-mint">Global</span>
      </div>

      <header>
        <h1 className="font-display text-3xl font-bold tracking-tight text-cream md:text-4xl">Platform share &amp; growth</h1>
        <p className="mt-2 max-w-2xl text-sm text-cream/60">
          Which ecommerce platform is winning — live market share, how fast each is growing, and the net impact of migrations. Scope: <span className="text-cream/85">{scopeLabel}</span>.
        </p>
        <p className="mt-2 flex items-center gap-1.5 text-xs text-cream/40">
          <span className="text-mint">✓</span> Covering <span className="font-mono text-cream/60">{coverage.stores.toLocaleString()}</span> stores across <span className="font-mono text-cream/60">{coverage.countries}</span> countries here. Coverage is deepest in our focus markets (Africa + Japan); global breadth is actively expanding as we pull in more sources.
        </p>
      </header>

      <PlatformFilters regions={regionOpts} cmsOptions={CMS_OPTS} countryOptions={countryOpts} />

      {share.length === 0 ? (
        <p className="py-12 text-center text-sm text-cream/40">No platform data for this scope yet.</p>
      ) : (
        <>
          {/* Winning CMS callout */}
          {winner && (
            <section className="rounded-2xl border border-cyan/20 bg-gradient-to-b from-cyan/[0.06] to-transparent p-5">
              <div className="text-xs font-semibold uppercase tracking-wide text-cyan">Leading platform · {scopeLabel}</div>
              <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-display text-2xl font-bold text-cream">{cmsLabel(winner.cms)}</span>
                <span className="font-mono text-sm text-cream/70">{winner.pct}% share · {winner.live.toLocaleString()} live stores</span>
                {winner.newWeek > 0 && <span className="font-mono text-xs text-mint">+{winner.newWeek.toLocaleString()} new this week</span>}
              </div>
            </section>
          )}

          {/* CMS market share */}
          <section className="rounded-2xl border border-cream/10 bg-cream/[0.02] p-5 md:p-6">
            <h2 className="font-display text-lg text-cream">Market share by platform</h2>
            <p className="mt-0.5 text-xs text-cream/45">Live stores per CMS · new launches this week (vs last).</p>
            <ul className="mt-4 space-y-2.5">
              {share.map((s, i) => {
                const delta = s.newWeek - s.newPrev;
                return (
                  <li key={s.cms} className={`group rounded-xl p-2 -m-2 ${i === 0 ? "bg-cyan/[0.05]" : ""}`}>
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="flex items-center gap-2">
                        <span className={`w-4 text-right font-mono text-xs ${i === 0 ? "text-cyan" : "text-cream/30"}`}>{i + 1}</span>
                        <span className={i === 0 ? "font-medium text-cream" : "text-cream/80"}>{cmsLabel(s.cms)}</span>
                      </span>
                      <span className="flex items-center gap-3 font-mono text-xs">
                        <span className="text-cream">{s.pct}%</span>
                        <span className="w-16 text-right text-cream/45">{s.live.toLocaleString()}</span>
                        <span className={`w-16 text-right ${s.newWeek > 0 ? "text-mint" : "text-cream/30"}`}>{s.newWeek > 0 ? `+${s.newWeek}` : "0"}/wk</span>
                        <span className={`w-12 text-right ${delta > 0 ? "text-mint" : delta < 0 ? "text-orange" : "text-cream/25"}`}>{delta === 0 ? "±0" : delta > 0 ? `▲${delta}` : `▼${Math.abs(delta)}`}</span>
                      </span>
                    </div>
                    <div className="ml-6 mt-1.5 h-1.5 overflow-hidden rounded-full bg-cream/[0.06]"><div className={`h-full rounded-full bg-gradient-to-r ${i === 0 ? "from-cyan to-cyan/40" : "from-cream/40 to-cream/15"}`} style={{ width: `${Math.max(2, (100 * s.live) / shareMax)}%` }} /></div>
                  </li>
                );
              })}
            </ul>
          </section>

          {/* Launch trend */}
          <section className="rounded-2xl border border-cream/10 bg-cream/[0.02] p-5 md:p-6">
            <div className="mb-3">
              <h2 className="font-display text-lg text-cream">Launch stream</h2>
              <p className="mt-0.5 text-xs text-cream/45">New stores going live each day in {scopeLabel}, by platform.</p>
            </div>
            <LaunchTrend data={trend} />
          </section>

          {/* Migration flows */}
          <section className="rounded-2xl border border-cream/10 bg-cream/[0.02] p-5 md:p-6">
            <h2 className="font-display text-lg text-cream">Migration impact</h2>
            <p className="mt-0.5 mb-4 text-xs text-cream/45">Net stores each platform gained or lost through migrations (confirmed platform switches) in {scopeLabel}.</p>
            {migMovers.length === 0 ? (
              <p className="py-4 text-sm text-cream/40">No confirmed migrations in this scope yet.</p>
            ) : (
              <ul className="space-y-2">
                {migMovers.map((m) => {
                  const up = m.net > 0;
                  return (
                    <li key={m.cms} className="flex items-center justify-between gap-3 rounded-xl border border-cream/10 bg-cream/[0.015] px-4 py-2.5">
                      <span className="flex items-center gap-2.5">
                        <span className={`grid h-6 w-6 place-items-center rounded-md text-xs ${up ? "bg-mint/15 text-mint" : "bg-orange/15 text-orange"}`}>{up ? "↑" : "↓"}</span>
                        <span className="text-sm text-cream">{cmsLabel(m.cms)}</span>
                      </span>
                      <span className="flex items-center gap-4 font-mono text-xs">
                        <span className="text-cream/45">{m.joined} in · {m.left} out</span>
                        <span className={`w-16 text-right font-semibold ${up ? "text-mint" : "text-orange"}`}>{up ? "+" : "−"}{Math.abs(m.net).toLocaleString()} net</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
