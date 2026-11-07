"use client";

import { useEffect, useState } from "react";
import { InteractiveBars } from "@/app/components/interactive-bars";

type Provider = { label: string; type: string; total: number; cumulative: number[] };
type Series = { granularity: string; buckets: string[]; providers: Provider[]; storesCumulative: number[] };
const TYPES = [["PSP", "PSP"], ["BNPL", "BNPL"], ["APM", "APM"]] as const;
const TONE: Record<string, string> = { PSP: "orange", BNPL: "mint", APM: "lilac" };

/** Who won LAST MONTH's newly-launched stores — a non-cumulative snapshot (the acquisition
 *  leaderboard a PSP watches): of the stores that launched in the last complete month with a verified
 *  checkout, how many chose each provider. Derived from the month-grain adoption series' last complete
 *  bucket, so it shares the cached /api/provider-adoption fetch. Hover a bar for the share. */
export function LastMonthWinners({ country, platform }: { country: string; platform: string }) {
  const [data, setData] = useState<Series | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [type, setType] = useState<string>("PSP");

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      setLoading(true); setErr(null);
      const p = new URLSearchParams({ country, grain: "month" });
      if (platform && platform !== "all") p.set("platform", platform);
      try {
        const r = await fetch(`/api/provider-adoption?${p.toString()}`, { signal: ac.signal });
        if (!r.ok) throw new Error(r.status === 403 ? "Subscribers only" : "Couldn't load");
        setData(await r.json());
      } catch (e) {
        if ((e as Error).name !== "AbortError") setErr((e as Error).message);
      } finally { setLoading(false); }
    })();
    return () => ac.abort();
  }, [country, platform]);

  const buckets = data?.buckets ?? [];
  // Last COMPLETE month = the penultimate bucket (the final bucket is the current, still-partial month).
  const idx = buckets.length >= 2 ? buckets.length - 2 : buckets.length - 1;
  const monthLabel = idx >= 0 ? new Date(buckets[idx] + "T00:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }) : "";
  const stores = data?.storesCumulative ?? [];
  const dStores = idx > 0 ? (stores[idx] ?? 0) - (stores[idx - 1] ?? 0) : stores[idx] ?? 0;
  const rows = (data?.providers ?? [])
    .filter((p) => p.type === type)
    .map((p) => {
      const d = idx > 0 ? (p.cumulative[idx] ?? 0) - (p.cumulative[idx - 1] ?? 0) : p.cumulative[idx] ?? 0;
      const count = Math.max(0, d);
      return { label: p.label, count, pct: dStores ? Math.round((100 * count) / dStores) : 0 };
    })
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return (
    <div className="rounded-[2rem] border border-cream/12 bg-cream/[0.03] p-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Who won last month&rsquo;s new stores{monthLabel ? ` — ${monthLabel}` : ""}</h3>
          <p className="mt-1 text-sm text-cream/45">
            Of the {dStores ? dStores.toLocaleString() + " " : ""}stores that <b className="text-cream/70">launched {monthLabel || "last month"}</b> with a verified checkout, how many chose each provider — a non-cumulative snapshot. Hover a bar for the share.
          </p>
        </div>
        <div className="flex gap-1 rounded-full border border-cream/12 p-1" title="gateway type">
          {TYPES.map(([k, l]) => (
            <button key={k} onClick={() => setType(k)}
              className={`rounded-full px-3 py-1 text-xs transition ${type === k ? "bg-cyan font-semibold text-cyan-deep" : "text-cream/50 hover:text-cream"}`}>{l}</button>
          ))}
        </div>
      </div>
      <div className="mt-5">
        {loading ? (
          <div className="grid h-40 place-items-center text-sm text-cream/40">Loading…</div>
        ) : err ? (
          <div className="grid h-40 place-items-center text-sm text-orange">{err}</div>
        ) : rows.length ? (
          <InteractiveBars data={rows} tone={TONE[type] ?? "orange"} initialLimit={10} pctSuffix={`of ${monthLabel || "last month"}'s new stores`} />
        ) : (
          <p className="text-sm text-cream/40">No {type} stores with a verified checkout launched {monthLabel || "last month"} yet — recent months fill in as launch-dating and checkout coverage catch up.</p>
        )}
      </div>
    </div>
  );
}
