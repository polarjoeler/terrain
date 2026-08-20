"use client";

import { useState } from "react";
import Link from "next/link";
import { Wordmark } from "@/app/components/logo";
import { classify, PAY_TYPES, type PayType } from "@/lib/payments-taxonomy";
import type { InsightsData, InsightItem } from "@/lib/insights";

const PERIODS = ["Day", "Week", "Month", "Quarter", "Year"] as const;
type Period = (typeof PERIODS)[number];
const PERIOD_DAYS: Record<Period, number> = { Day: 1, Week: 7, Month: 30, Quarter: 91, Year: 365 };
const COMPARISON: Record<Period, string> = { Day: "DoD", Week: "WoW", Month: "MoM", Quarter: "QoQ", Year: "YoY" };
const PERIOD_PREV: Record<Period, string> = { Day: "yesterday", Week: "last week", Month: "last month", Quarter: "last quarter", Year: "last year" };
const TYPE_LABEL: Record<PayType, string> = { PSP: "Payment service providers", BNPL: "Buy now, pay later", APM: "Wallets & alternative methods" };
const TYPE_TONE: Record<PayType, string> = { PSP: "orange", BNPL: "mint", APM: "lilac" };

const daysAgo = (d: string) => (Date.now() - new Date(d).getTime()) / 864e5;
const fill = (tone: string) =>
  tone === "mint" ? "bg-mint" : tone === "lilac" ? "bg-lilac" : tone === "cyan" ? "bg-cyan" : "bg-orange";

/** Absolute change in store COUNT vs the comparison period (no % — a real number
 *  of stores). Shown on the distribution drill-ins so "change" is unambiguous. */
function CountDelta({ v }: { v: number | null }) {
  if (v === null) return <span className="text-cream/25">—</span>;
  if (v === 0) return <span className="text-cream/35">±0</span>;
  const up = v > 0;
  return (
    <span className={up ? "text-mint" : "text-orange"}>
      {up ? "▲+" : "▼−"}{Math.abs(v).toLocaleString()}
    </span>
  );
}

function TileDelta({ abs, pct }: { abs: number | null; pct: number | null }) {
  if (abs === null) return <span className="text-cream/25">—</span>;
  if (abs === 0) return <span className="text-cream/35">±0</span>;
  const up = abs > 0;
  return (
    <span className={up ? "text-mint" : "text-orange"}>
      {up ? "▲" : "▼"} {up ? "+" : "−"}{Math.abs(abs).toLocaleString()}
      {pct != null ? ` · ${Math.abs(pct)}%` : ""}
    </span>
  );
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[2rem] border border-cream/12 bg-cream/[0.03] p-7">
      <h3 className="text-lg font-semibold">{title}</h3>
      {subtitle && <p className="mt-1 text-sm text-cream/45">{subtitle}</p>}
      <div className="mt-6">{children}</div>
    </div>
  );
}

function TrendLine({ data }: { data: number[] }) {
  const w = 520, h = 160;
  const max = Math.max(...data, 1);
  const step = w / Math.max(data.length - 1, 1);
  const pts = data.map((v, i) => [i * step, h - (v / max) * (h - 20)] as const);
  const line = pts.map((p) => p.join(",")).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full">
      <polygon points={`0,${h} ${line} ${w},${h}`} fill="var(--color-orange)" opacity="0.12" />
      <polyline points={line} fill="none" stroke="var(--color-orange)" strokeWidth="3" strokeLinejoin="round" />
      {pts.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="4" fill="var(--color-orange)" />)}
    </svg>
  );
}

/** A distribution (providers / themes / apps / categories) with % + absolute
 *  counts, drill-in to see every item, and per-item change vs the chosen period. */
function DistroCard({
  title, subtitle, data, baseline, tone = "orange",
}: {
  title: string;
  subtitle: string;
  data: InsightItem[];
  baseline: InsightItem[] | null;
  tone?: string;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? data : data.slice(0, 6);
  const bmap = baseline ? new Map(baseline.map((i) => [i.label, i.count])) : null;

  return (
    <Card title={title} subtitle={subtitle}>
      <div className={`space-y-3 ${all && data.length > 10 ? "max-h-96 overflow-y-auto pr-1" : ""}`}>
        {shown.map((i) => {
          const prev = bmap?.get(i.label);
          const cdel = prev != null ? i.count - prev : null;
          return (
            <div key={i.label} className="flex items-center gap-3">
              <div className="w-32 shrink-0 truncate text-sm text-cream/75" title={i.label}>{i.label}</div>
              <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-cream/10">
                <div className={`h-full rounded-full ${fill(tone)}`} style={{ width: `${Math.min(i.pct, 100)}%` }} />
              </div>
              <div className="w-9 shrink-0 text-right text-sm tabular-nums text-cream/70">{i.pct}%</div>
              <div className="w-14 shrink-0 text-right text-xs tabular-nums text-cream/40">{i.count.toLocaleString()}</div>
              {bmap && <div className="w-16 shrink-0 text-right text-xs tabular-nums">{<CountDelta v={cdel} />}</div>}
            </div>
          );
        })}
      </div>
      {data.length > 6 && (
        <button
          onClick={() => setAll((a) => !a)}
          className="mt-4 text-sm font-medium text-cream/50 transition hover:text-cream"
        >
          {all ? "Show top 6" : `See all ${data.length} →`}
        </button>
      )}
    </Card>
  );
}

export function InsightsView({
  data, history, baselineDate,
}: {
  data: InsightsData;
  history: InsightsData[];
  baselineDate?: string | null;
}) {
  const [platform, setPlatform] = useState("Shopify");
  const [period, setPeriod] = useState<Period>("Week");

  // Trends/comparisons only look back to the baseline (reset after a bulk import
  // so the batch doesn't skew growth or forward-churn).
  const effHistory = baselineDate ? history.filter((h) => h.date >= baselineDate) : history;

  // A period is available only if we have a snapshot at least that far back.
  const baselineFor = (p: Period): InsightsData | null => {
    const want = PERIOD_DAYS[p];
    const older = effHistory.filter((h) => h.date !== data.date && daysAgo(h.date) >= want);
    return older.length ? older[older.length - 1] : null;
  };
  const available = (p: Period) => baselineFor(p) !== null;
  const base = available(period) ? baselineFor(period) : null;
  // Absolute + % change of a metric vs the selected period's baseline.
  const metric = (key: keyof InsightsData): { abs: number | null; pct: number | null } => {
    const b = base && typeof base[key] === "number" ? (base[key] as number) : null;
    if (b == null) return { abs: null, pct: null };
    const abs = (data[key] as number) - b;
    return { abs, pct: b > 0 ? Math.round((100 * abs) / b) : null };
  };

  const plusTrend = effHistory.length >= 2 ? effHistory.map((h) => h.plusTotal) : null;

  // Group providers by PSP / BNPL / APM for the segmented payment breakdown.
  const groupByType = (list?: InsightItem[]): Record<PayType, InsightItem[]> => {
    const g: Record<PayType, InsightItem[]> = { PSP: [], BNPL: [], APM: [] };
    for (const p of list ?? []) g[classify(p.label)].push(p);
    return g;
  };
  const provByType = groupByType(data.paymentsByProvider);
  const baseProvByType = base ? groupByType(base.paymentsByProvider) : null;

  // Store survival "going forward" — measured against the earliest snapshot
  // (the baseline), so the one-time import's dead/migrated stores don't count;
  // we only show what churns from that point on.
  const baseline = effHistory.length >= 2 ? effHistory[0] : null;
  const fwdMigrated = baseline ? Math.max(0, data.churn.migrated - baseline.churn.migrated) : 0;
  const fwdDead = baseline ? Math.max(0, data.churn.dead - baseline.churn.dead) : 0;
  const trackedBase = data.churn.active + fwdMigrated + fwdDead;
  const fwdSurvival = trackedBase > 0 ? Math.round((100 * data.churn.active) / trackedBase) : null;

  const tiles = [
    { n: data.storesTotal.toLocaleString(), label: "stores tracked", ...metric("storesTotal"), tone: "outline" },
    { n: `+${data.newThisWeek}`, label: "new this week", abs: null, pct: null, tone: "mint" },
    { n: data.plusTotal.toLocaleString(), label: "Shopify Plus", ...metric("plusTotal"), tone: "lilac" },
    { n: data.paymentsVerifiedStores.toLocaleString(), label: "with payment data", abs: null, pct: null, tone: "outline" },
  ];

  return (
    <div className="min-h-screen px-4 py-6 md:px-8">
      <div className="mx-auto max-w-6xl">
        <nav className="flex items-center justify-between">
          <Link href="/"><Wordmark size="text-xl" /></Link>
          <div className="flex items-center gap-3">
            <Link href="/dashboard" className="text-sm text-cream/60 hover:text-cream">← Dashboard</Link>
            <span className="rounded-full border border-mint/25 bg-mint/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-mint">
              Live data
            </span>
          </div>
        </nav>

        <header className="mt-10">
          <h1 className="font-display text-4xl md:text-5xl">Market Insights</h1>
          <p className="mt-2 max-w-2xl text-cream/60">
            Where the South African Shopify market is heading — payment stacks,
            themes, apps, categories and enterprise adoption, from {data.storesTotal.toLocaleString()} live
            stores we track.
          </p>
        </header>

        {/* filters */}
        <div className="mt-6 flex flex-wrap items-center gap-6 rounded-3xl border border-cream/12 bg-cream/[0.03] px-5 py-4">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-cream/40">Platform</span>
            <button onClick={() => setPlatform("Shopify")} className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm ${platform === "Shopify" ? "bg-cream text-ink" : "border border-cream/15 text-cream/60"}`}>
              <span className="h-2 w-2 rounded-full bg-[#95BF47]" /> Shopify
            </button>
            <button disabled className="cursor-not-allowed rounded-full border border-cream/10 px-3.5 py-1.5 text-sm text-cream/30">WooCommerce · soon</button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-cream/40">Compare</span>
            {PERIODS.map((p) => {
              const ok = available(p);
              return (
                <button
                  key={p}
                  onClick={() => ok && setPeriod(p)}
                  disabled={!ok}
                  title={ok ? `Compare vs ${PERIOD_DAYS[p]} days ago` : "Not enough history yet — builds daily"}
                  className={`rounded-full px-3.5 py-1.5 text-sm transition ${
                    !ok
                      ? "cursor-not-allowed border border-cream/8 text-cream/25"
                      : period === p
                        ? "bg-orange text-cream"
                        : "border border-cream/15 text-cream/60 hover:border-cream/40"
                  }`}
                >
                  {p}
                </button>
              );
            })}
            <span className="ml-1 text-xs text-cream/40">
              {base ? `vs ${PERIOD_PREV[period]} · ${COMPARISON[period]}` : "comparisons build as daily snapshots accumulate"}
            </span>
          </div>
        </div>

        {/* stat tiles */}
        <div className="mt-6 grid gap-4 md:grid-cols-4">
          {tiles.map((s) => (
            <div key={s.label} className={`rounded-3xl px-5 py-6 ${s.tone === "mint" ? "bg-mint text-ink" : s.tone === "lilac" ? "bg-lilac text-ink" : "border border-cream/12 text-cream"}`}>
              <div className="font-display text-5xl leading-none">{s.n}</div>
              <div className="mt-2 flex items-center justify-between">
                <span className={`text-xs font-medium uppercase tracking-wide ${s.tone === "outline" ? "text-cream/45" : "opacity-70"}`}>{s.label}</span>
                <span className="text-xs font-semibold"><TileDelta abs={s.abs} pct={s.pct} /></span>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 grid gap-5 md:grid-cols-2">
          {/* Payment providers — broken out by PSP / BNPL / APM, each drillable */}
          <Card
            title="Payment intelligence"
            subtitle={`Checkout-verified across ${data.paymentsVerifiedStores.toLocaleString()} of ${data.storesTotal.toLocaleString()} stores (${Math.round((100 * data.paymentsVerifiedStores) / Math.max(data.storesTotal, 1))}% and growing)`}
          >
            {/* Headline signals for payment-company subscribers */}
            <div className="mb-6 grid grid-cols-3 gap-3">
              {[
                { n: `${data.paymentsByType.BNPL.pct}%`, l: "offer BNPL" },
                { n: (data.paymentsVerifiedStores - data.paymentsByType.BNPL.count).toLocaleString(), l: "no BNPL yet" },
                { n: `${data.paymentsByType.PSP.pct}%`, l: "use a PSP" },
              ].map((s) => (
                <div key={s.l} className="rounded-2xl border border-cream/10 bg-cream/[0.02] p-3 text-center">
                  <div className="font-display text-2xl text-cream">{s.n}</div>
                  <div className="mt-0.5 text-[11px] uppercase tracking-wide text-cream/45">{s.l}</div>
                </div>
              ))}
            </div>
            <div className="space-y-7">
              {PAY_TYPES.map((t) =>
                provByType[t].length ? (
                  <div key={t}>
                    <div className="mb-3 flex flex-wrap items-baseline gap-x-2">
                      <span className="text-xs font-bold uppercase tracking-wide text-cream/80">{t}</span>
                      <span className="text-[11px] text-cream/40">
                        {TYPE_LABEL[t]} · {data.paymentsByType[t].pct}% of stores ({data.paymentsByType[t].count.toLocaleString()})
                      </span>
                    </div>
                    <DrillList data={provByType[t]} baseline={baseProvByType?.[t] ?? null} tone={TYPE_TONE[t]} showBaseline={!!base} />
                  </div>
                ) : null,
              )}
            </div>
          </Card>

          <div className="space-y-5">
            <Card title="Shopify Plus adoption" subtitle="Cumulative total over time">
              {plusTrend ? <TrendLine data={plusTrend} /> : (
                <div className="grid h-32 place-items-center rounded-2xl border border-dashed border-cream/12 text-sm text-cream/40">
                  Trend builds as daily snapshots accumulate
                </div>
              )}
              <p className="pt-3 text-sm text-cream/45">
                {data.plusNewThisWeek} new this week · {data.plusTotal} total.
              </p>
            </Card>
            <Card title="Leading provider at checkout" subtitle="First gateway offered (best-effort)">
              <DrillList data={data.firstProvider} baseline={base?.firstProvider ?? null} tone="orange" showBaseline={!!base} />
            </Card>
          </div>

          <DistroCard title="Categories" subtitle={`Of ${data.categoriesKnown.toLocaleString()} categorised stores`} data={data.categories} baseline={base?.categories ?? null} tone="cyan" />
          <DistroCard title="Theme market share" subtitle={`Of ${data.themesKnown.toLocaleString()} stores with a known theme`} data={data.themes} baseline={base?.themes ?? null} tone="mint" />
          <DistroCard title="Top apps installed" subtitle={`Of ${data.appsKnown.toLocaleString()} stores with app data`} data={data.apps} baseline={base?.apps ?? null} tone="lilac" />
        </div>

        {/* Store survival & churn — measured GOING FORWARD from our baseline, so
            the one-time bulk import's already-dead/migrated stores don't skew it. */}
        <section className="mt-10">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-cream/50">Store survival &amp; churn</h2>
            <span className="text-xs text-cream/35">
              {baseline ? `tracked since ${baseline.date}` : "tracking from today — forward churn accrues daily"}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[
              { n: fwdSurvival != null ? `${fwdSurvival}%` : "—", label: "still live", tone: "mint" },
              { n: data.churn.active.toLocaleString(), label: "actively tracked", tone: "outline" },
              { n: fwdMigrated.toLocaleString(), label: "migrated off · since baseline", tone: "outline" },
              { n: fwdDead.toLocaleString(), label: "closed · since baseline", tone: "outline" },
            ].map((c) => (
              <div key={c.label} className={`rounded-3xl px-5 py-6 ${c.tone === "mint" ? "bg-mint text-ink" : "border border-cream/12 text-cream"}`}>
                <div className="font-display text-4xl leading-none tracking-tight md:text-5xl">{c.n}</div>
                <div className={`mt-2 text-xs font-medium uppercase tracking-wide ${c.tone === "mint" ? "opacity-70" : "text-cream/45"}`}>{c.label}</div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-cream/40">
            Forward-looking: we only count stores that migrate off Shopify or close <em>after</em> we
            started tracking them — the one-time bulk import is excluded so this reflects real ongoing churn.
          </p>
        </section>

        <p className="mt-8 text-center text-xs text-cream/40">
          Live Terrain data · {data.date} · {data.storesTotal.toLocaleString()} live South African stores
        </p>
      </div>
    </div>
  );
}

/** Compact drill-in list (used inside the payments cards). */
function DrillList({
  data, baseline, tone, showBaseline,
}: {
  data: InsightItem[];
  baseline: InsightItem[] | null;
  tone: string;
  showBaseline: boolean;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? data : data.slice(0, 6);
  const bmap = baseline ? new Map(baseline.map((i) => [i.label, i.count])) : null;
  return (
    <>
      <div className={`space-y-3 ${all && data.length > 10 ? "max-h-80 overflow-y-auto pr-1" : ""}`}>
        {shown.map((i) => {
          const prev = bmap?.get(i.label);
          const cdel = prev != null ? i.count - prev : null;
          return (
            <div key={i.label} className="flex items-center gap-3">
              <div className="w-32 shrink-0 truncate text-sm text-cream/75" title={i.label}>{i.label}</div>
              <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-cream/10">
                <div className={`h-full rounded-full ${fill(tone)}`} style={{ width: `${Math.min(i.pct, 100)}%` }} />
              </div>
              <div className="w-9 shrink-0 text-right text-sm tabular-nums text-cream/70">{i.pct}%</div>
              <div className="w-14 shrink-0 text-right text-xs tabular-nums text-cream/40">{i.count.toLocaleString()}</div>
              {showBaseline && <div className="w-16 shrink-0 text-right text-xs tabular-nums"><CountDelta v={cdel} /></div>}
            </div>
          );
        })}
      </div>
      {data.length > 6 && (
        <button onClick={() => setAll((a) => !a)} className="mt-4 text-sm font-medium text-cream/50 transition hover:text-cream">
          {all ? "Show top 6" : `See all ${data.length} →`}
        </button>
      )}
    </>
  );
}
