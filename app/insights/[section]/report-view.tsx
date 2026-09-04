"use client";

import Link from "next/link";
import type { SectionReport } from "@/lib/insights";

const PERIODS = [["day", "Day"], ["week", "Week"], ["month", "Month"], ["quarter", "Quarter"], ["year", "Year"]] as const;
const PERIOD_NOUN: Record<string, string> = { day: "day", week: "week", month: "month", quarter: "quarter", year: "year" };

/** Standalone, time-filtered report for one insights dimension. Each row: the all-time
 *  store count and GENUINE ADOPTIONS in the selected period (discovery + real switches,
 *  never backfill). Click a row to open the pre-filtered stores in the dashboard. */
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
            {report.allTimeStores.toLocaleString()} stores all-time · {report.items.length.toLocaleString()} {report.title.toLowerCase()}.
            The number after each total is <span className="text-mint">genuine adoptions this {noun}</span> — stores that
            newly started using it{report.section === "payments" ? " or switched to it" : ""}, excluding catch-up on already-known stores.
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <div className="flex gap-1 rounded-full border border-cream/12 p-1">
              {PERIODS.map(([k, l]) => (
                <button
                  key={k}
                  onClick={() => setParam("period", k)}
                  className={`rounded-full px-3 py-1 text-xs transition ${report.period === k ? "bg-cyan font-semibold text-cyan-deep" : "text-cream/50 hover:text-cream"}`}
                >{l}</button>
              ))}
            </div>
            {countries.length > 1 && (
              <select
                value={country}
                onChange={(e) => setParam("country", e.target.value)}
                className="rounded-full border border-cream/15 bg-transparent px-3 py-1.5 text-xs text-cream outline-none focus:border-cream/50"
              >
                {countries.map((c) => <option key={c} value={c} className="text-ink">{c}</option>)}
              </select>
            )}
          </div>
        </header>

        {report.items.length === 0 ? (
          <p className="mt-10 text-sm text-cream/40">No data for this market yet.</p>
        ) : (
          <ul className="mt-8 space-y-1.5">
            {report.items.map((it) => (
              <li key={it.label}>
                <Link href={drill(it.label)} className="group block rounded-xl border border-cream/10 px-4 py-2.5 transition hover:border-cream/25 hover:bg-cream/[0.02]">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-sm text-cream/85 group-hover:text-cream">{it.label}</span>
                    <span className="flex shrink-0 items-baseline gap-3 text-xs tabular-nums">
                      <span className="text-cream/50">{it.total.toLocaleString()}</span>
                      <span className={`w-16 text-right ${it.period > 0 ? "text-mint" : it.period < 0 ? "text-orange" : "text-cream/25"}`}
                        title={`genuine adoptions this ${noun}`}>
                        {it.period > 0 ? "+" : it.period < 0 ? "−" : ""}{it.period !== 0 ? Math.abs(it.period).toLocaleString() : "±0"}
                      </span>
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-cream/10">
                    <div className="h-full rounded-full bg-cyan/60" style={{ width: `${Math.max(2, (it.total / max) * 100)}%` }} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
