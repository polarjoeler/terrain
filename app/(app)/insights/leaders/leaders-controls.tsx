"use client";

import { useRouter } from "next/navigation";
import { marketLabel, groupByRegion } from "@/lib/markets";

export function LeadersControls({ markets, country, cohort }: {
  markets: { country: string; stores: number }[];
  country: string;
  cohort: number;
}) {
  const router = useRouter();
  const go = (next: { country?: string; cohort?: number }) => {
    const qs = new URLSearchParams();
    qs.set("country", next.country ?? country);
    qs.set("cohort", String(next.cohort ?? cohort));
    router.push(`/insights/leaders?${qs.toString()}`);
  };
  return (
    <div className="flex flex-wrap items-center gap-5 rounded-2xl border border-cream/12 bg-cream/[0.03] px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-cream/40">Market</span>
        <select value={country} onChange={(e) => go({ country: e.target.value })}
          className="rounded-full border border-cream/15 bg-transparent px-3.5 py-1.5 text-sm text-cream outline-none focus:border-cream/50 [&>optgroup]:bg-ink-deep [&>option]:bg-ink-deep">
          {groupByRegion(markets).map(({ region, items }) => (
            <optgroup key={region} label={region}>
              {items.map((m) => <option key={m.country} value={m.country} className="text-ink">{marketLabel(m.country)} ({m.stores.toLocaleString()})</option>)}
            </optgroup>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-cream/40">Cohort</span>
        {[100, 500].map((n) => (
          <button key={n} onClick={() => go({ cohort: n })}
            className={`rounded-full px-3.5 py-1 text-xs transition ${cohort === n ? "bg-orange text-cream" : "border border-cream/15 text-cream/55 hover:border-cream/40"}`}>
            Top {n}
          </button>
        ))}
      </div>
    </div>
  );
}
