"use client";

import { useEffect, useState } from "react";

type Point = { date: string; launched: number; cumulative: number; churned: number };
type Series = { period: string; points: Point[]; churnTrackedFrom: string | null; totalLaunched: number };
const PERIODS = [["day", "Day"], ["week", "Week"], ["month", "Month"], ["quarter", "Quarter"], ["year", "Year"]] as const;

/** Retroactive Shopify-growth chart: bars = new stores launched per period (back to 2006
 *  via launch dates), a mint line = cumulative growth, orange = churn (forward-only).
 *  Filterable by period + custom date range. Fetches the paid-gated /api/growth. */
export function GrowthChart({ country, provider, title = "Shopify store growth" }: { country?: string; provider?: string; title?: string }) {
  const [period, setPeriod] = useState("month");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<Series | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      setLoading(true);
      setErr(null);
      const p = new URLSearchParams({ period });
      if (country) p.set("country", country);
      if (provider) p.set("provider", provider);
      if (from) p.set("from", from);
      if (to) p.set("to", to);
      try {
        const r = await fetch(`/api/growth?${p.toString()}`, { signal: ac.signal });
        if (!r.ok) throw new Error(r.status === 403 ? "Subscribers only" : "Couldn't load");
        setData(await r.json());
      } catch (e) {
        if ((e as Error).name !== "AbortError") setErr((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
    return () => ac.abort();
  }, [period, country, provider, from, to]);

  const pts = data?.points ?? [];
  const W = 720, H = 250, padL = 6, padR = 6, padB = 22, padT = 8;
  const iw = W - padL - padR, ih = H - padT - padB;
  const maxL = Math.max(1, ...pts.map((p) => Math.max(p.launched, p.churned)));
  const maxC = Math.max(1, ...pts.map((p) => p.cumulative));
  const bw = pts.length ? iw / pts.length : iw;
  const x = (i: number) => padL + i * bw;
  const yBar = (v: number) => padT + ih - (v / maxL) * ih;
  const yLine = (v: number) => padT + ih - (v / maxC) * ih;
  const linePts = pts.map((p, i) => `${x(i) + bw / 2},${yLine(p.cumulative)}`).join(" ");
  const labelEvery = Math.max(1, Math.ceil(pts.length / 8));

  return (
    <div className="rounded-[2rem] border border-cream/12 bg-cream/[0.03] p-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">{title}</h3>
          <p className="mt-1 text-sm text-cream/45">
            New stores launched per {period} (retroactive) · cumulative growth · churn where tracked
            {provider ? " · by current gateway" : ""}
          </p>
        </div>
        <div className="flex gap-1 rounded-full border border-cream/12 p-1">
          {PERIODS.map(([k, l]) => (
            <button key={k} onClick={() => setPeriod(k)}
              className={`rounded-full px-3 py-1 text-xs transition ${period === k ? "bg-cyan font-semibold text-cyan-deep" : "text-cream/50 hover:text-cream"}`}>{l}</button>
          ))}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-cream/50">
        <span>Range:</span>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded border border-cream/15 bg-transparent px-2 py-1 text-cream" />
        <span>→</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="rounded border border-cream/15 bg-transparent px-2 py-1 text-cream" />
        {(from || to) && <button onClick={() => { setFrom(""); setTo(""); }} className="text-cream/40 hover:text-cream">clear</button>}
        <span className="ml-auto flex items-center gap-3">
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm bg-cyan opacity-70" />new</span>
          <span className="flex items-center gap-1"><span className="inline-block h-1.5 w-3 rounded-sm bg-mint" />cumulative</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm bg-orange opacity-75" />churn</span>
        </span>
      </div>

      <div className="mt-4">
        {loading ? (
          <div className="grid h-60 place-items-center text-sm text-cream/40">Loading…</div>
        ) : err ? (
          <div className="grid h-60 place-items-center text-sm text-orange">{err}</div>
        ) : pts.length === 0 ? (
          <div className="grid h-60 place-items-center text-sm text-cream/40">No launch-dated stores for this filter yet.</div>
        ) : (
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
            {pts.map((p, i) => (
              <g key={p.date}>
                <rect x={x(i) + bw * 0.18} width={bw * 0.64} y={yBar(p.launched)} height={Math.max(0, padT + ih - yBar(p.launched))} fill="var(--color-cyan)" opacity="0.7">
                  <title>{`${p.date}: ${p.launched.toLocaleString()} new${p.churned ? `, ${p.churned.toLocaleString()} churned` : ""} · ${p.cumulative.toLocaleString()} total`}</title>
                </rect>
                {p.churned > 0 && (
                  <rect x={x(i) + bw * 0.34} width={bw * 0.32} y={yBar(p.churned)} height={Math.max(0, padT + ih - yBar(p.churned))} fill="var(--color-orange)" opacity="0.8" />
                )}
              </g>
            ))}
            <polyline points={linePts} fill="none" stroke="var(--color-mint)" strokeWidth="2.5" strokeLinejoin="round" />
            {pts.map((p, i) => (i % labelEvery === 0 ? (
              <text key={`t${p.date}`} x={x(i) + bw / 2} y={H - 6} textAnchor="middle" fill="var(--color-cream)" fillOpacity="0.4" fontSize="9">{p.date.slice(0, period === "year" ? 4 : 7)}</text>
            ) : null))}
          </svg>
        )}
      </div>

      <p className="mt-2 text-xs text-cream/35">
        {data?.churnTrackedFrom
          ? `Churn tracked from ${data.churnTrackedFrom} — historical churn isn't available (a store's death is only seen once we're watching it).`
          : "Churn tracking builds as our liveness checks run — historical churn isn't available."}
        {data ? ` · ${data.totalLaunched.toLocaleString()} launch-dated stores.` : ""}
      </p>
    </div>
  );
}
