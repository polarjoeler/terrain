"use client";

import { useState } from "react";
import { InteractiveBars, CountUp } from "@/app/components/interactive-bars";
import { marketLabel } from "@/lib/markets";
import { PAY_TYPES, type PayType } from "@/lib/payments-taxonomy";
import type { ProviderInsights, ProviderTrendPoint, NewSharePeriod, NewShareBucket, ProviderStore } from "@/lib/provider-insights";

const TYPE_LABEL: Record<PayType, string> = { PSP: "Payment service providers", BNPL: "Buy now, pay later", APM: "Wallets & alt. methods" };
const TYPE_TONE: Record<PayType, string> = { PSP: "orange", BNPL: "mint", APM: "lilac" };

const usd = (n: number | null) =>
  n == null ? "—" : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n)}`;

type Range = "Day" | "Week" | "Month" | "Quarter" | "Year" | "All";
const RANGES: Range[] = ["Day", "Week", "Month", "Quarter", "Year", "All"];
const RANGE_DAYS: Record<Range, number> = { Day: 1, Week: 7, Month: 30, Quarter: 91, Year: 365, All: Infinity };

/** Holistic market-share view — share % over time, filterable by range. */
function MarketShareChart({ history, currentShare, provider, scope }: { history: ProviderTrendPoint[]; currentShare: number; provider: string; scope: string }) {
  const [range, setRange] = useState<Range>("All");
  const pts = (() => {
    const days = RANGE_DAYS[range];
    if (days === Infinity) return history;
    const cut = Date.now() - days * 864e5;
    return history.filter((h) => new Date(h.date + "T00:00:00Z").getTime() >= cut);
  })();

  const w = 720, h = 200, padL = 34, padB = 22, padT = 12;
  const maxY = Math.max(1, ...pts.map((p) => p.share)) * 1.15;
  const x = (i: number) => padL + (pts.length <= 1 ? 0 : (i / (pts.length - 1)) * (w - padL - 8));
  const y = (v: number) => padT + (1 - v / maxY) * (h - padT - padB);

  return (
    <div className="rounded-[2rem] border border-cream/12 bg-cream/[0.03] p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-cream">Market share over time</h3>
          <p className="mt-1 text-xs text-cream/45">Share of checkout-verified stores using {provider} · {scope}</p>
          <div className="mt-3 flex items-baseline gap-2">
            <CountUp value={Math.round(currentShare)} className="font-display text-5xl leading-none text-cream" />
            <span className="font-display text-2xl text-cream/60">%</span>
            <span className="ml-1 text-xs text-cream/40">today</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {RANGES.map((r) => (
            <button key={r} onClick={() => setRange(r)}
              className={`rounded-full px-3 py-1 text-xs transition ${range === r ? "bg-cyan text-cyan-deep" : "border border-cream/15 text-cream/55 hover:border-cream/40"}`}>
              {r === "All" ? "All time" : r}
            </button>
          ))}
        </div>
      </div>

      {pts.length >= 2 ? (
        <svg viewBox={`0 0 ${w} ${h}`} className="mt-5 w-full">
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={padL} x2={w} y1={y(maxY * f)} y2={y(maxY * f)} stroke="var(--color-cream)" strokeOpacity="0.08" />
              <text x={0} y={y(maxY * f) + 3} className="fill-cream/40" fontSize="9">{Math.round(maxY * f)}%</text>
            </g>
          ))}
          <polygon points={`${x(0)},${h - padB} ${pts.map((p, i) => `${x(i)},${y(p.share)}`).join(" ")} ${x(pts.length - 1)},${h - padB}`} fill="var(--color-cyan)" opacity="0.1" />
          <polyline points={pts.map((p, i) => `${x(i)},${y(p.share)}`).join(" ")} fill="none" stroke="var(--color-cyan)" strokeWidth="2.5" strokeLinejoin="round" />
          {pts.map((p, i) => <circle key={i} cx={x(i)} cy={y(p.share)} r="3" fill="var(--color-cyan)"><title>{p.date}: {p.share}% ({p.total} of {p.verifiedBase})</title></circle>)}
          <text x={padL} y={h - 6} className="fill-cream/40" fontSize="9">{pts[0].date}</text>
          <text x={w} y={h - 6} textAnchor="end" className="fill-cream/40" fontSize="9">{pts[pts.length - 1].date}</text>
        </svg>
      ) : (
        <div className="mt-5 grid h-32 place-items-center rounded-2xl border border-dashed border-cream/12 text-center text-sm text-cream/45">
          Trend line builds as daily snapshots accrue — the first point is recorded.<br />Come back over the next few weeks to watch it move.
        </div>
      )}
    </div>
  );
}

/** Share of NEWLY-DISCOVERED stores that chose this provider, bucketed — the
 *  acquisition curve, with a granularity toggle. This is the leading indicator a
 *  payment company watches; a good spot to later overlay switches to/from. */
const NS_PERIODS: NewSharePeriod[] = ["day", "week", "month", "quarter", "year"];
const NS_LABELS: Record<NewSharePeriod, string> = { day: "Day", week: "Week", month: "Month", quarter: "Quarter", year: "Year" };
function NewShareChart({ series, provider }: { series: Record<NewSharePeriod, NewShareBucket[]>; provider: string }) {
  const [period, setPeriod] = useState<NewSharePeriod>("month");
  const data = series[period] ?? [];
  const has = data.some((b) => b.total > 0);
  const fmt = (iso: string) => {
    const dt = new Date(iso + "T00:00:00Z");
    const mo = dt.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
    const yr = String(dt.getUTCFullYear()).slice(2);
    if (period === "year") return String(dt.getUTCFullYear());
    if (period === "quarter") return `Q${Math.floor(dt.getUTCMonth() / 3) + 1} ’${yr}`;
    if (period === "month") return `${mo} ’${yr}`;
    return `${dt.getUTCDate()} ${mo}`;
  };
  return (
    <div className="rounded-[2rem] border border-cream/12 bg-cream/[0.03] p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-cream">Share of new stores choosing {provider}</h3>
          <p className="mt-1 text-xs text-cream/45">Of newly-discovered stores with a verified checkout, the % that picked {provider} — the acquisition curve.</p>
        </div>
        <div className="flex gap-1 rounded-full border border-cream/12 p-1">
          {NS_PERIODS.map((p) => (
            <button key={p} onClick={() => setPeriod(p)}
              className={`rounded-full px-3 py-1 text-xs transition ${period === p ? "bg-mint font-semibold text-ink" : "text-cream/50 hover:text-cream"}`}>
              {NS_LABELS[p]}
            </button>
          ))}
        </div>
      </div>
      {has ? (
        <div className="mt-5 space-y-2">
          {data.map((b) => (
            <div key={b.date} className="flex items-center gap-3">
              <span className="w-16 shrink-0 text-xs tabular-nums text-cream/60">{fmt(b.date)}</span>
              <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-cream/10">
                <div className="h-full rounded-full bg-mint" style={{ width: `${b.total ? Math.max(2, Math.min(b.share, 100)) : 0}%` }} />
              </div>
              <span className="w-10 shrink-0 text-right text-sm tabular-nums text-cream">{b.total ? `${b.share}%` : "—"}</span>
              <span className="w-16 shrink-0 text-right text-xs tabular-nums text-cream/40">{b.mine}/{b.total}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-5 text-sm text-cream/40">Not enough new-store data at this granularity yet — it fills in as discovery and checkout coverage grow. (Later, a good place to also show stores switching to or from {provider}.)</p>
      )}
    </div>
  );
}

/** The provider's stores — sortable (recent / largest / leads-checkout), filterable
 *  by Shopify Plus and by discovery period. Replaces the old "biggest stores" table,
 *  which sorted on own-sourced revenue that's still too sparse to be meaningful. */
type StoreSort = "recent" | "largest" | "rank";
type StorePeriod = "all" | "year" | "quarter" | "month" | "week";
const SP_DAYS: Record<StorePeriod, number> = { all: Infinity, year: 365, quarter: 91, month: 30, week: 7 };
const SP_SORTS: [StoreSort, string][] = [["recent", "Most recent"], ["largest", "Largest"], ["rank", "Leads checkout"]];
const SP_PERIODS: [StorePeriod, string][] = [["all", "All time"], ["year", "Past year"], ["quarter", "Past quarter"], ["month", "Past month"], ["week", "Past week"]];

function StoresTable({ stores, provider }: { stores: ProviderStore[]; provider: string }) {
  const [sort, setSort] = useState<StoreSort>("recent");
  const [plusOnly, setPlusOnly] = useState(false);
  const [period, setPeriod] = useState<StorePeriod>("all");

  const filtered = stores.filter((s) => {
    if (plusOnly && !s.plus) return false;
    if (period !== "all") {
      if (!s.discoveredAt) return false;
      if ((Date.now() - new Date(s.discoveredAt).getTime()) / 864e5 > SP_DAYS[period]) return false;
    }
    return true;
  });
  const sorted = [...filtered].sort((a, b) => {
    if (sort === "recent") return (b.discoveredAt ?? "").localeCompare(a.discoveredAt ?? "");
    if (sort === "largest") return (b.sales ?? 0) - (a.sales ?? 0) || (b.productCount ?? 0) - (a.productCount ?? 0);
    return a.rank - b.rank || (b.discoveredAt ?? "").localeCompare(a.discoveredAt ?? "");
  }).slice(0, 100);

  return (
    <div className="rounded-[2rem] border border-cream/12 bg-cream/[0.03] p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-cream">Stores on {provider}</h3>
          <p className="mt-1 text-xs text-cream/45">
            {filtered.length.toLocaleString()} store{filtered.length === 1 ? "" : "s"}{plusOnly ? " · Plus only" : ""}{period !== "all" ? ` · ${SP_PERIODS.find(([k]) => k === period)![1].toLowerCase()}` : ""} · showing top {sorted.length}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1 rounded-full border border-cream/12 p-1">
            {SP_SORTS.map(([k, l]) => (
              <button key={k} onClick={() => setSort(k)}
                className={`rounded-full px-3 py-1 text-xs transition ${sort === k ? "bg-mint font-semibold text-ink" : "text-cream/50 hover:text-cream"}`}>{l}</button>
            ))}
          </div>
          <select value={period} onChange={(e) => setPeriod(e.target.value as StorePeriod)}
            className="rounded-full border border-cream/15 bg-transparent px-3 py-1.5 text-xs text-cream outline-none focus:border-cream/50">
            {SP_PERIODS.map(([k, l]) => <option key={k} value={k} className="text-ink">{l}</option>)}
          </select>
          <button onClick={() => setPlusOnly((v) => !v)}
            className={`rounded-full px-3 py-1.5 text-xs transition ${plusOnly ? "bg-lilac/25 font-semibold text-lilac" : "border border-cream/15 text-cream/55 hover:text-cream"}`}>⚡ Plus</button>
        </div>
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[680px] text-left text-sm text-cream/80">
          <thead className="text-xs uppercase tracking-wide text-cream/40">
            <tr>
              <th className="pb-3 pr-4">Store</th><th className="pb-3 pr-4">Market</th>
              <th className="pb-3 pr-4">Discovered</th><th className="pb-3 pr-4">Size</th>
              <th className="pb-3 pr-4">{provider} rank</th><th className="pb-3">Checkout stack</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => (
              <tr key={s.domain} className="border-t border-cream/10 align-top">
                <td className="py-3 pr-4">
                  <div className="flex items-center gap-1.5 font-medium text-cream">{s.name ?? s.domain}{s.plus && <span className="rounded bg-lilac/20 px-1 py-0.5 text-[8px] font-bold text-lilac">PLUS</span>}</div>
                  <a href={`https://${s.domain}`} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-cream/40 hover:underline">{s.domain}</a>
                </td>
                <td className="py-3 pr-4 whitespace-nowrap text-cream/60">{s.country ? marketLabel(s.country) : "—"}</td>
                <td className="py-3 pr-4 whitespace-nowrap tabular-nums text-cream/55">{s.discoveredAt ?? "—"}</td>
                <td className="py-3 pr-4 whitespace-nowrap">{s.sales != null ? usd(s.sales) : s.productCount != null ? `${s.productCount} products` : "—"}</td>
                <td className="py-3 pr-4"><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${s.rank === 1 ? "bg-mint/15 text-mint" : "bg-cream/10 text-cream/60"}`}>#{s.rank}</span></td>
                <td className="py-3 text-xs text-cream/55">{s.gateways.map((g, i) => (
                  <span key={i} className={g.toLowerCase() === provider.toLowerCase() ? "font-semibold text-cream" : ""}>{g}{i < s.gateways.length - 1 ? " · " : ""}</span>
                ))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sorted.length === 0 && <p className="mt-4 text-sm text-cream/40">No stores match — widen the period or turn off the Plus filter.</p>}
    </div>
  );
}

export function ProviderView({
  data: d, history, newShare, shareToken, isAdmin, countries, country,
}: {
  data: ProviderInsights;
  history: ProviderTrendPoint[];
  newShare: Record<NewSharePeriod, NewShareBucket[]>;
  shareToken: string;
  isAdmin: boolean;
  countries: string[];
  country: string;
}) {
  const [copied, setCopied] = useState(false);
  const linkFor = (c: string) => {
    const qs = new URLSearchParams();
    if (shareToken) qs.set("t", shareToken);
    if (c) qs.set("country", c);
    return `/p/${d.provider.toLowerCase()}?${qs.toString()}`;
  };
  const copyLink = () => {
    navigator.clipboard?.writeText(`${window.location.origin}${linkFor(country)}`)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
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
            {countries.length > 0 && (
              <select
                value={country}
                onChange={(e) => { window.location.href = linkFor(e.target.value); }}
                className="rounded-full border border-cream/15 bg-transparent px-3.5 py-1.5 text-sm text-cream outline-none focus:border-cream/50"
              >
                <option value="" className="text-ink">All markets</option>
                {countries.map((c) => <option key={c} value={c} className="text-ink">{marketLabel(c)}</option>)}
              </select>
            )}
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
            Checkout-verified positioning {country ? `in the ${marketLabel(country)} Shopify market` : "across every market we track"} — where {d.provider}{" "}
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

        {/* market share over time — the holistic view */}
        <div className="mt-6">
          <MarketShareChart history={history} currentShare={d.verifiedBase ? Math.round((10000 * d.total) / d.verifiedBase) / 100 : 0} provider={d.provider} scope={country ? marketLabel(country) : "all markets"} />
        </div>

        {/* share of NEW stores over time — the acquisition curve, D/W/M/Q/Y */}
        <div className="mt-6">
          <NewShareChart series={newShare} provider={d.provider} />
        </div>

        {/* position in the checkout stack */}
        <div className="mt-6 rounded-[2rem] border border-cream/12 bg-cream/[0.03] p-6">
          <h3 className="text-lg font-semibold text-cream">Position in the checkout stack</h3>
          <div className="mt-4 grid gap-5 md:grid-cols-[auto_1fr] md:items-center">
            <div className="grid grid-cols-2 gap-3 text-center">
              <div className="rounded-2xl border border-cream/10 px-6 py-3">
                <div className="font-display text-2xl text-cream">#{d.avgRank ?? "—"}</div>
                <div className="mt-0.5 text-[11px] uppercase tracking-wide text-cream/45">avg rank</div>
              </div>
              <div className="rounded-2xl border border-cream/10 px-6 py-3">
                <div className="font-display text-2xl text-cream">{d.avgStackSize ?? "—"}</div>
                <div className="mt-0.5 text-[11px] uppercase tracking-wide text-cream/45">avg gateways / checkout</div>
              </div>
            </div>
            <InteractiveBars data={d.rankDist} tone="cyan" initialLimit={8} />
          </div>
        </div>

        {/* segment penetration + checkout placement by cohort */}
        <div className="mt-6 grid gap-5 md:grid-cols-2">
          <Card title={`Where ${d.provider} wins by segment`} subtitle="High-value & enterprise penetration — the volume a payment company sells for">
            <div className="space-y-3">
              {d.segments.map((sg) => (
                <div key={sg.key} className="flex items-center gap-3">
                  <div className="w-24 shrink-0 text-sm text-cream/75">{sg.label}</div>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-cream/10">
                    <div className="h-full rounded-full bg-mint" style={{ width: `${Math.max(2, Math.min(sg.pct, 100))}%` }} />
                  </div>
                  <div className="w-10 shrink-0 text-right text-sm tabular-nums text-cream">{sg.pct}%</div>
                  <div className="w-16 shrink-0 text-right text-xs tabular-nums text-cream/40">{sg.mine}/{sg.total}</div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[11px] text-cream/35">Top 100 / Top 500 are by sales rank; Plus = Shopify Plus merchants. Bar = share of that segment using {d.provider}.</p>
          </Card>

          <Card title="Checkout placement by cohort" subtitle={`Where ${d.provider} sits in the stack by store vintage — more top-spots with newer stores means you're winning the default`}>
            {d.rankByCohort.length ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-cream/35">
                  <span className="w-12">Cohort</span><span className="flex-1">Lead the checkout</span><span className="w-14 text-right">Avg rank</span><span className="w-12 text-right">Stores</span>
                </div>
                {d.rankByCohort.map((c) => (
                  <div key={c.cohort} className="flex items-center gap-2">
                    <span className="w-12 shrink-0 text-sm text-cream/75">{c.cohort}</span>
                    <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-cream/10">
                      <div className="h-full rounded-full bg-cyan" style={{ width: `${Math.max(2, c.topSpotPct)}%` }} />
                    </div>
                    <span className="w-14 shrink-0 text-right text-sm tabular-nums text-cream">#{c.avgRank}</span>
                    <span className="w-12 shrink-0 text-right text-xs tabular-nums text-cream/40">{c.total}</span>
                  </div>
                ))}
              </div>
            ) : <p className="text-sm text-cream/40">Fills in as launch dates are captured (own-sourced).</p>}
          </Card>
        </div>

        {/* head-to-head — a PSP only competes with other PSPs */}
        <div className="mt-6 rounded-[2rem] border border-cream/12 bg-cream/[0.03] p-6">
          <h3 className="text-lg font-semibold text-cream">Head-to-head — rival PSPs</h3>
          <p className="mt-1 text-xs text-cream/45">
            A PSP competes with other PSPs, not with BNPL or wallets (those coexist). Of {d.provider}&apos;s {d.pspRivalry.total.toLocaleString()} stores,
            how often does a <span className="text-cream/80">rival PSP</span> also sit at checkout?
          </p>
          <div className="mt-4 grid gap-5 md:grid-cols-[auto_1fr] md:items-center">
            <div className="grid grid-cols-2 gap-3 text-center">
              <div className="rounded-2xl border border-mint/25 bg-mint/[0.06] px-6 py-3">
                <div className="font-display text-2xl text-mint">{d.pspRivalry.soloPspPct}%</div>
                <div className="mt-0.5 text-[11px] uppercase tracking-wide text-cream/45">sole PSP</div>
              </div>
              <div className="rounded-2xl border border-orange/25 bg-orange/[0.06] px-6 py-3">
                <div className="font-display text-2xl text-orange">{d.pspRivalry.withRivalPct}%</div>
                <div className="mt-0.5 text-[11px] uppercase tracking-wide text-cream/45">rival PSP present</div>
              </div>
            </div>
            <div>
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-cream/50">Rival PSPs they run against</div>
              {d.pspRivalry.rivals.length
                ? <InteractiveBars data={d.pspRivalry.rivals} tone="orange" initialLimit={6} />
                : <p className="text-sm text-cream/35">No rival PSP seen alongside — {d.provider} stands alone at these checkouts.</p>}
            </div>
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
          <Card title="Market share by market" subtitle={`Of each market's checkout-verified stores, the % using ${d.provider}`}>
            {d.byCountry.length ? (
              <div className="space-y-2.5">
                {d.byCountry.map((c) => (
                  <div key={c.label} className="flex items-center gap-3">
                    <div className="w-28 shrink-0 truncate text-sm text-cream/75">{marketLabel(c.label)}</div>
                    <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-cream/10">
                      <div className="h-full rounded-full bg-mint" style={{ width: `${Math.max(2, Math.min(c.pct, 100))}%` }} />
                    </div>
                    <div className="w-11 shrink-0 text-right text-sm tabular-nums text-cream">{c.pct}%</div>
                    <div className="w-20 shrink-0 text-right text-xs tabular-nums text-cream/40">{c.count.toLocaleString()} store{c.count === 1 ? "" : "s"}</div>
                  </div>
                ))}
              </div>
            ) : <p className="text-sm text-cream/40">No market data.</p>}
          </Card>
          <Card title="Market share by store vintage" subtitle={`Of stores first seen each year, the % now using ${d.provider} (bar = your store count)`}><InteractiveBars data={d.vintage} tone="lilac" initialLimit={12} /></Card>
          <Card title="Store size" subtitle="Estimated monthly sales"><InteractiveBars data={d.sizeBands} tone="cyan" /></Card>
        </div>

        {/* stores on the provider — filterable */}
        <div className="mt-6">
          <StoresTable stores={d.stores} provider={d.provider} />
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
