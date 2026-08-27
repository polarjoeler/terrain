"use client";

import { useState } from "react";
import { InteractiveBars, CountUp } from "@/app/components/interactive-bars";
import { marketLabel } from "@/lib/markets";
import { PAY_TYPES, type PayType } from "@/lib/payments-taxonomy";
import type { ProviderInsights, ProviderTrendPoint } from "@/lib/provider-insights";

const TYPE_LABEL: Record<PayType, string> = { PSP: "Payment service providers", BNPL: "Buy now, pay later", APM: "Wallets & alt. methods" };
const TYPE_TONE: Record<PayType, string> = { PSP: "orange", BNPL: "mint", APM: "lilac" };

const usd = (n: number | null) =>
  n == null ? "—" : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n)}`;

function Sparkline({ data }: { data: number[] }) {
  if (data.length < 2) return null;
  const w = 240, h = 44, max = Math.max(...data, 1), min = Math.min(...data);
  const span = Math.max(max - min, 1), step = w / (data.length - 1);
  const pts = data.map((v, i) => `${i * step},${h - ((v - min) / span) * (h - 8) - 4}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-11 w-full">
      <polyline points={pts} fill="none" stroke="var(--color-cyan)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function ProviderView({
  data: d, history, shareToken, isAdmin,
}: {
  data: ProviderInsights;
  history: ProviderTrendPoint[];
  shareToken: string;
  isAdmin: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copyLink = () => {
    const url = `${window.location.origin}/p/${d.provider.toLowerCase()}?t=${shareToken}`;
    navigator.clipboard?.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };

  const tiles = [
    { n: d.total, label: "stores at checkout", sub: `of ${d.verifiedBase.toLocaleString()} verified` },
    { n: d.topSpot, label: "in the top spot", sub: `${d.topSpotPct}% lead the checkout` },
    { n: d.exclusive, label: "sole payment option", sub: `${d.exclusivePct}% use only you` },
    { n: d.newLast7, label: "new stores this week", sub: `${d.shareOfNew7}% of ${d.newStores7} new chose you` },
  ];

  return (
    <div className="min-h-screen px-4 py-8 md:px-8">
      <div className="mx-auto max-w-6xl">
        <nav className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <span className="font-display text-2xl text-cream">{d.provider}</span>
            <span className="text-sm text-cream/45">market insights</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="rounded-full border border-mint/25 bg-mint/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-mint">Live data</span>
            {isAdmin && (
              <button onClick={copyLink} className="rounded-full border border-cyan/40 px-3 py-1 text-xs text-cyan transition hover:bg-cyan/10">
                {copied ? "✓ Link copied" : "Copy share link"}
              </button>
            )}
          </div>
        </nav>

        <header className="mt-8">
          <h1 className="font-display text-4xl md:text-5xl">How {d.provider} is doing across the market</h1>
          <p className="mt-2 max-w-2xl text-cream/60">
            Checkout-verified positioning across the {marketLabel(d.byCountry[0]?.label ?? "ZA")} Shopify market — where {d.provider}{" "}
            leads, where it's the only option, who it's up against, and the stores choosing it.
          </p>
        </header>

        {/* hero tiles */}
        <div className="mt-8 grid gap-4 sm:grid-cols-2 md:grid-cols-4">
          {tiles.map((t) => (
            <div key={t.label} className="rounded-3xl border border-cream/12 bg-cream/[0.03] px-5 py-6">
              <CountUp value={t.n} className="font-display text-4xl leading-none text-cream" />
              <div className="mt-2 text-xs font-semibold uppercase tracking-wide text-cream/50">{t.label}</div>
              <div className="mt-1 text-xs text-cream/40">{t.sub}</div>
            </div>
          ))}
        </div>

        {/* trend + headline */}
        <div className="mt-6 grid gap-5 md:grid-cols-2">
          <div className="rounded-[2rem] border border-cream/12 bg-cream/[0.03] p-6">
            <h3 className="text-lg font-semibold text-cream">Adoption over time</h3>
            {history.length >= 2 ? (
              <>
                <div className="mt-4"><Sparkline data={history.map((h) => h.total)} /></div>
                <p className="mt-2 text-sm text-cream/50">
                  {history[0].total} → {history[history.length - 1].total} stores since {history[0].date}.
                </p>
              </>
            ) : (
              <div className="mt-4 grid h-24 place-items-center rounded-2xl border border-dashed border-cream/12 text-sm text-cream/40">
                Trend builds weekly — first snapshot recorded. Check back next week.
              </div>
            )}
          </div>
          <div className="rounded-[2rem] border border-cream/12 bg-cream/[0.03] p-6">
            <h3 className="text-lg font-semibold text-cream">Position in the checkout stack</h3>
            <div className="mt-4 grid grid-cols-2 gap-3 text-center">
              <div className="rounded-2xl border border-cream/10 p-3">
                <div className="font-display text-2xl text-cream">#{d.avgRank ?? "—"}</div>
                <div className="mt-0.5 text-[11px] uppercase tracking-wide text-cream/45">avg rank</div>
              </div>
              <div className="rounded-2xl border border-cream/10 p-3">
                <div className="font-display text-2xl text-cream">{d.avgStackSize ?? "—"}</div>
                <div className="mt-0.5 text-[11px] uppercase tracking-wide text-cream/45">avg gateways / checkout</div>
              </div>
            </div>
            <div className="mt-4"><InteractiveBars data={d.rankDist} tone="cyan" initialLimit={6} /></div>
          </div>
        </div>

        {/* competitors — segmented by payment type */}
        <div className="mt-6 rounded-[2rem] border border-cream/12 bg-cream/[0.03] p-6">
          <h3 className="text-lg font-semibold text-cream">Who they compete with</h3>
          <p className="mt-1 text-xs text-cream/45">
            Gateways appearing alongside {d.provider} at checkout, grouped by type. {d.provider} is a{" "}
            <span className="text-cream/80">{d.providerType}</span> — same-type gateways are direct competition; other types coexist.
          </p>
          <div className="mt-5 grid gap-6 md:grid-cols-3">
            {PAY_TYPES.map((t) => (
              <div key={t}>
                <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
                  <span className="text-xs font-bold uppercase tracking-wide text-cream/80">{t}</span>
                  {t === d.providerType && <span className="rounded-full bg-orange/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-orange">direct</span>}
                  <span className="text-[11px] text-cream/40">{TYPE_LABEL[t]}</span>
                </div>
                {d.coOccurrenceByType[t].length
                  ? <InteractiveBars data={d.coOccurrenceByType[t]} tone={TYPE_TONE[t]} initialLimit={6} />
                  : <p className="text-sm text-cream/35">None seen alongside.</p>}
              </div>
            ))}
          </div>
        </div>

        {/* breakdowns */}
        <div className="mt-6 grid gap-5 md:grid-cols-2">
          <Card title="Market share by store vintage" subtitle={`Of stores first seen each year, the % now using ${d.provider} (bar = your store count)`}><InteractiveBars data={d.vintage} tone="lilac" initialLimit={12} /></Card>
          <Card title="Markets" subtitle="Where these stores are"><InteractiveBars data={d.byCountry.map((c) => ({ ...c, label: marketLabel(c.label) }))} tone="mint" /></Card>
          <Card title="Store size" subtitle="Estimated monthly sales"><InteractiveBars data={d.sizeBands} tone="cyan" /></Card>
        </div>

        {/* top stores */}
        <div className="mt-6 rounded-[2rem] border border-cream/12 bg-cream/[0.03] p-6">
          <h3 className="text-lg font-semibold text-cream">Biggest stores on {d.provider}</h3>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm text-cream/80">
              <thead className="text-xs uppercase tracking-wide text-cream/40">
                <tr>
                  <th className="pb-3 pr-4">Store</th><th className="pb-3 pr-4">Market</th>
                  <th className="pb-3 pr-4">Est. sales</th><th className="pb-3 pr-4">{d.provider} rank</th>
                  <th className="pb-3">Checkout stack</th>
                </tr>
              </thead>
              <tbody>
                {d.topStores.map((s) => (
                  <tr key={s.domain} className="border-t border-cream/10 align-top">
                    <td className="py-3 pr-4">
                      <div className="font-medium text-cream">{s.name ?? s.domain}</div>
                      <a href={`https://${s.domain}`} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-cream/40 hover:underline">{s.domain}</a>
                    </td>
                    <td className="py-3 pr-4 whitespace-nowrap text-cream/60">{s.country ? marketLabel(s.country) : "—"}</td>
                    <td className="py-3 pr-4 whitespace-nowrap font-medium">{usd(s.sales)}</td>
                    <td className="py-3 pr-4"><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${s.rank === 1 ? "bg-mint/15 text-mint" : "bg-cream/10 text-cream/60"}`}>#{s.rank}</span></td>
                    <td className="py-3 text-xs text-cream/55">{s.gateways.map((g, i) => (
                      <span key={i} className={g.toLowerCase() === d.provider.toLowerCase() ? "text-cream font-semibold" : ""}>{g}{i < s.gateways.length - 1 ? " · " : ""}</span>
                    ))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <p className="mt-8 text-center text-xs text-cream/40">Live Terrain data · {d.total.toLocaleString()} checkout-verified stores · {new Date().toISOString().slice(0, 10)}</p>
      </div>
    </div>
  );
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[2rem] border border-cream/12 bg-cream/[0.03] p-6">
      <h3 className="text-lg font-semibold text-cream">{title}</h3>
      {subtitle && <p className="mt-1 text-xs text-cream/45">{subtitle}</p>}
      <div className="mt-4">{children}</div>
    </div>
  );
}
