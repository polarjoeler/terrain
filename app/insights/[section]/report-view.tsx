"use client";

import Link from "next/link";
import type { SectionReport, ReportItem } from "@/lib/insights";

const PERIODS = [["day", "Day"], ["week", "Week"], ["month", "Month"], ["quarter", "Quarter"], ["year", "Year"]] as const;
const PERIOD_NOUN: Record<string, string> = { day: "day", week: "week", month: "month", quarter: "quarter", year: "year" };
const TYPE_ORDER = ["PSP", "APM", "BNPL"] as const;
const TYPE_LABEL: Record<string, string> = {
  PSP: "Payment gateways · PSP", APM: "Wallets, rails & cards · APM", BNPL: "Buy-now-pay-later · BNPL",
};

function Sparkline({ data }: { data: number[] }) {
  if (data.length < 2) return <div className="mt-1.5 h-4" />;
  const w = 120, h = 18, min = Math.min(...data), max = Math.max(...data), rng = max - min || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - 1 - ((v - min) / rng) * (h - 2)}`).join(" ");
  const up = data[data.length - 1] >= data[0];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="mt-1.5 h-4 w-full" aria-hidden>
      <polyline points={pts} fill="none" stroke={up ? "var(--color-mint)" : "var(--color-orange)"} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Δ vs the comparison period: change in merchant count, and change in share in percentage points. */
function Delta({ dc, ds }: { dc?: number; ds?: number }) {
  if (dc == null) return <span className="w-24 text-right text-cream/25">new</span>;
  const dir = (ds ?? dc);
  const col = dir > 0 ? "text-mint" : dir < 0 ? "text-orange" : "text-cream/30";
  return (
    <span className={`w-24 text-right ${col}`}>
      {dir > 0 ? "▲" : dir < 0 ? "▼" : "·"} {dc > 0 ? "+" : ""}{dc.toLocaleString()}
      {ds != null && <span className="ml-1 opacity-70">{ds > 0 ? "+" : ""}{ds}pp</span>}
    </span>
  );
}

export function ReportView({ report, country, countries }: { report: SectionReport; country: string; countries: string[] }) {
  const setParam = (k: string, v: string) => {
    const p = new URLSearchParams(window.location.search);
    p.set(k, v);
    window.location.assign(`?${p.toString()}`);
  };
  const drill = (label: string) => {
    const p = new URLSearchParams();
    p.set(report.drillParam, label);
    if (country) p.set("country", country);
    return `/dashboard?${p.toString()}`;
  };
  const noun = PERIOD_NOUN[report.period] ?? "week";
  const max = Math.max(...report.items.map((i) => i.total), 1);
  const back = report.back ?? 0;
  const canHistory = report.section === "payments";
  const grouped = report.items.some((i) => i.type);
  const hasShare = report.items.some((i) => i.share != null);

  const Row = (it: ReportItem) => (
    <li key={it.label}>
      <Link href={drill(it.label)} className="group block rounded-xl border border-cream/10 px-4 py-2.5 transition hover:border-cream/25 hover:bg-cream/[0.02]">
        <div className="flex items-center justify-between gap-3">
          <span className="truncate text-sm text-cream/85 group-hover:text-cream">{it.label}</span>
          <span className="flex shrink-0 items-center gap-3 text-xs tabular-nums">
            {it.share != null && <span className="w-12 text-right font-semibold text-cream/90">{it.share}%</span>}
            <span className="w-14 text-right text-cream/50">{it.total.toLocaleString()}</span>
            {hasShare
              ? <Delta dc={it.deltaCount} ds={it.deltaShare} />
              : <span className={`w-16 text-right ${it.period > 0 ? "text-mint" : it.period < 0 ? "text-orange" : "text-cream/25"}`} title={`genuine adoptions this ${noun}`}>
                  {it.period > 0 ? "+" : it.period < 0 ? "−" : ""}{it.period !== 0 ? Math.abs(it.period).toLocaleString() : "±0"}
                </span>}
          </span>
        </div>
        {it.trend && it.trend.length > 1
          ? <Sparkline data={it.trend} />
          : <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-cream/10"><div className="h-full rounded-full bg-cyan/60" style={{ width: `${Math.max(2, (it.total / max) * 100)}%` }} /></div>}
      </Link>
    </li>
  );

  return (
    <main className="min-h-screen px-4 py-6 md:px-8">
      <div className="mx-auto max-w-3xl">
        <nav className="flex items-center justify-between">
          <Link href="/insights" className="text-sm text-cream/60 hover:text-cream">← Insights</Link>
          <span className="rounded-full border border-cream/15 px-3 py-1 text-xs text-cream/50">{country}</span>
        </nav>

        <header className="mt-8">
          <h1 className="font-display text-4xl text-cream md:text-5xl">{report.title}</h1>
          <p className="mt-2 text-cream/60">
            {hasShare
              ? <>{report.items.length.toLocaleString()} {report.title.toLowerCase()} · <span className="text-cream/80">{report.asOf}</span>. <span className="text-cream/85">Share</span> = % of payment-verified merchants in this market using it; the arrow is the change{report.comparedTo ? <> since <span className="text-cream/80">{report.comparedTo}</span></> : <> vs the prior {noun}</>} (Δ merchants and Δ share in percentage points), and the line is its recent share trend.</>
              : <>{report.allTimeStores.toLocaleString()} stores all-time · {report.items.length.toLocaleString()} {report.title.toLowerCase()}. The number after each total is <span className="text-mint">genuine adoptions this {noun}</span> — stores that newly started using it, excluding catch-up on already-known stores.</>}
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <div className="flex gap-1 rounded-full border border-cream/12 p-1">
              {PERIODS.map(([k, l]) => (
                <button key={k} onClick={() => setParam("period", k)}
                  className={`rounded-full px-3 py-1 text-xs transition ${report.period === k ? "bg-cyan font-semibold text-cyan-deep" : "text-cream/50 hover:text-cream"}`}
                >{l}</button>
              ))}
            </div>

            {canHistory && (
              <div className="flex items-center gap-1 rounded-full border border-cream/12 p-1 text-xs">
                <button onClick={() => setParam("back", String(back + 1))} title={`one ${noun} earlier`}
                  className="rounded-full px-2.5 py-1 text-cream/60 hover:bg-cream/[0.06] hover:text-cream">◀</button>
                <span className="min-w-[9rem] px-1 text-center tabular-nums text-cream/75">
                  {back === 0 ? "Now · latest" : `${report.asOf} · ${back} ${noun}${back > 1 ? "s" : ""} back`}
                </span>
                <button onClick={() => setParam("back", String(Math.max(0, back - 1)))} disabled={back === 0}
                  className={`rounded-full px-2.5 py-1 ${back === 0 ? "text-cream/20" : "text-cream/60 hover:bg-cream/[0.06] hover:text-cream"}`}>▶</button>
                {back > 0 && <button onClick={() => setParam("back", "0")} className="rounded-full px-2 py-1 text-cream/45 hover:text-cream">now</button>}
              </div>
            )}

            {countries.length > 1 && (
              <select value={country} onChange={(e) => setParam("country", e.target.value)}
                className="rounded-full border border-cream/15 bg-transparent px-3 py-1.5 text-xs text-cream outline-none focus:border-cream/50">
                {countries.map((c) => <option key={c} value={c} className="text-ink">{c}</option>)}
              </select>
            )}
          </div>
        </header>

        {report.items.length === 0 ? (
          <p className="mt-10 text-sm text-cream/40">{back > 0 ? "No snapshot for this market at that point yet." : "No data for this market yet."}</p>
        ) : grouped ? (
          <div className="mt-8 space-y-6">
            {TYPE_ORDER.map((t) => {
              const rows = report.items.filter((i) => i.type === t);
              if (!rows.length) return null;
              const share = rows.reduce((s, i) => s + (i.share ?? 0), 0);
              return (
                <section key={t}>
                  <div className="mb-2 flex items-baseline justify-between border-b border-cream/10 pb-1.5">
                    <h2 className="text-sm font-semibold text-cream/80">{TYPE_LABEL[t]}</h2>
                    <span className="text-xs text-cream/40 tabular-nums">{rows.length} providers · {Math.round(share)}% combined</span>
                  </div>
                  <ul className="space-y-1.5">{rows.map(Row)}</ul>
                </section>
              );
            })}
          </div>
        ) : (
          <ul className="mt-8 space-y-1.5">{report.items.map(Row)}</ul>
        )}
      </div>
    </main>
  );
}
