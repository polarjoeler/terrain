"use client";

import Link from "next/link";
import type { PaymentShift } from "@/lib/provider-insights";

const PERIODS = [["day", "Day"], ["week", "Week"], ["month", "Month"], ["quarter", "Quarter"], ["year", "Year"]] as const;
const NOUN: Record<string, string> = { day: "24 hours", week: "week", month: "month", quarter: "quarter", year: "year" };

/** Standalone report of genuine payment-provider switches — stores that added/dropped a
 *  gateway within the selected period. One row per store (its latest change). */
export function SwitchesView({ shifts, country, countries, period }: {
  shifts: PaymentShift[]; country: string; countries: string[]; period: string;
}) {
  const setParam = (k: string, v: string) => {
    const p = new URLSearchParams(window.location.search);
    p.set(k, v);
    window.location.assign(`?${p.toString()}`);
  };
  const noun = NOUN[period] ?? "month";

  return (
    <main className="min-h-screen px-4 py-6 md:px-8">
      <div className="mx-auto max-w-3xl">
        <nav className="flex items-center justify-between">
          <Link href="/insights" className="text-sm text-cream/60 hover:text-cream">← Insights</Link>
          <span className="rounded-full border border-cream/15 px-3 py-1 text-xs text-cream/50">{country}</span>
        </nav>

        <header className="mt-8">
          <h1 className="font-display text-4xl text-cream md:text-5xl">Provider switches</h1>
          <p className="mt-2 text-cream/60">
            Stores that added or dropped a payment gateway in the last {noun} — a live signal of merchants changing their checkout.
            One row per store (its latest change), genuine gateway changes only.
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <div className="flex gap-1 rounded-full border border-cream/12 p-1">
              {PERIODS.map(([k, l]) => (
                <button
                  key={k}
                  onClick={() => setParam("period", k)}
                  className={`rounded-full px-3 py-1 text-xs transition ${period === k ? "bg-cyan font-semibold text-cyan-deep" : "text-cream/50 hover:text-cream"}`}
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

        {shifts.length === 0 ? (
          <p className="mt-10 text-sm text-cream/40">No provider switches in this {noun} for {country}. Switches are caught as stores are re-probed on the 60-day cycle.</p>
        ) : (
          <ul className="mt-8 divide-y divide-cream/[0.06]">
            {shifts.map((s, i) => {
              const swap = s.added.length === 1 && s.removed.length === 1;
              return (
                <li key={i} className="py-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <a href={`https://${s.domain}`} target="_blank" rel="noopener noreferrer"
                      className="truncate font-mono text-xs text-cream/55 hover:text-cream hover:underline">{s.domain}</a>
                    <span className="shrink-0 text-[11px] tabular-nums text-cream/30">{s.changedAt}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-sm">
                    {swap ? (
                      <>
                        <span className="text-orange/75 line-through decoration-orange/40">{s.removed[0]}</span>
                        <span className="text-cream/30">→</span>
                        <span className="font-semibold text-mint">{s.added[0]}</span>
                      </>
                    ) : (
                      <>
                        {s.added.map((a) => <span key={`a${a}`} className="rounded bg-mint/15 px-2 py-0.5 text-xs font-medium text-mint">added {a}</span>)}
                        {s.removed.map((r) => <span key={`r${r}`} className="rounded bg-orange/15 px-2 py-0.5 text-xs font-medium text-orange">dropped {r}</span>)}
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
