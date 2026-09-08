"use client";

import { useEffect, useState, type MouseEvent } from "react";

type Point = { date: string; newStores: number; total: number; churned: number };
type Series = { period: string; points: Point[]; churnTrackedFrom: string | null; totalNew: number; currentTotal: number };
const PERIODS = [["day", "Day"], ["week", "Week"], ["month", "Month"], ["quarter", "Quarter"], ["year", "Year"]] as const;

/** Shopify-growth chart (forward-only, since we began tracking): diverging bars = new stores
 *  added per period (cyan, up) and churned stores (orange, down); a mint line = the total live
 *  store base, anchored to the real current count. Filterable by period + custom date range.
 *  Fetches the paid-gated /api/growth. */
export function GrowthChart({ country, provider, title = "Shopify store growth" }: { country?: string; provider?: string; title?: string }) {
  const [period, setPeriod] = useState("month");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<Series | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);

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
  const W = 760, H = 300, padL = 40, padR = 46, padB = 26, padT = 12;
  const iw = W - padL - padR, ih = H - padT - padB;
  const maxNew = Math.max(1, ...pts.map((p) => p.newStores));
  const maxChurn = Math.max(0, ...pts.map((p) => p.churned));
  const totals = pts.map((p) => p.total);
  const tMax = totals.length ? Math.max(...totals) : 1;
  const tMin = totals.length ? Math.min(...totals) : 0;
  const tSpan = Math.max(1, tMax - tMin);
  const baseY = padT + (maxNew / (maxNew + maxChurn || 1)) * ih;   // zero line: new above, churn below
  const bw = pts.length ? iw / pts.length : iw;
  const xAt = (i: number) => padL + i * bw;
  const upH = (v: number) => (v / maxNew) * (baseY - padT);
  const downH = (v: number) => (maxChurn ? (v / maxChurn) * (padT + ih - baseY) : 0);
  // right axis is zoomed to the total's own [min,max] range so the climb is visible
  const yTot = (v: number) => padT + 4 + (ih - 8) * (1 - (v - tMin) / tSpan);
  const totLine = pts.map((p, i) => `${xAt(i) + bw / 2},${yTot(p.total)}`).join(" ");
  const labelEvery = Math.max(1, Math.ceil(pts.length / 8));
  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((((e.clientX - r.left) / r.width) * W - padL) / bw);
    setHover(i >= 0 && i < pts.length ? i : null);
  };
  const hp = hover != null ? pts[hover] : null;

  return (
    <div className="rounded-[2rem] border border-cream/12 bg-cream/[0.03] p-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">{title}</h3>
          <p className="mt-1 text-sm text-cream/45">
            Bars: new stores added ↑ / churned ↓ per {period}. Line: total live store base
            {provider ? " on this gateway" : ""}.
          </p>
          {data && (
            <p className="mt-2 text-2xl font-semibold text-mint">
              {data.currentTotal.toLocaleString()}
              <span className="ml-2 text-sm font-normal text-cream/45">{provider ? "merchants" : "stores"} total</span>
            </p>
          )}
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
          <span className="flex items-center gap-1"><span className="inline-block h-1.5 w-3 rounded-sm bg-mint" />total stores</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm bg-orange opacity-75" />churn</span>
        </span>
      </div>

      <div className="relative mt-4" onMouseLeave={() => setHover(null)}>
        {loading ? (
          <div className="grid h-72 place-items-center text-sm text-cream/40">Loading…</div>
        ) : err ? (
          <div className="grid h-72 place-items-center text-sm text-orange">{err}</div>
        ) : pts.length === 0 ? (
          <div className="grid h-72 place-items-center text-sm text-cream/40">No stores discovered in this range yet.</div>
        ) : (
          <>
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full" onMouseMove={onMove}>
              {/* axes */}
              <line x1={padL} y1={baseY} x2={W - padR} y2={baseY} stroke="var(--color-cream)" strokeOpacity="0.28" />
              <line x1={padL} y1={padT} x2={padL} y2={padT + ih} stroke="var(--color-cream)" strokeOpacity="0.12" />
              <line x1={W - padR} y1={padT} x2={W - padR} y2={padT + ih} stroke="var(--color-mint)" strokeOpacity="0.18" />
              {/* left axis = per-period counts (new above 0, churn below) */}
              <text x={padL - 6} y={padT + 5} textAnchor="end" fill="var(--color-cyan)" fillOpacity="0.8" fontSize="10">{maxNew.toLocaleString()}</text>
              <text x={padL - 6} y={baseY + 3} textAnchor="end" fill="var(--color-cream)" fillOpacity="0.45" fontSize="10">0</text>
              {maxChurn > 0 && <text x={padL - 6} y={padT + ih} textAnchor="end" fill="var(--color-orange)" fillOpacity="0.8" fontSize="10">{maxChurn.toLocaleString()}</text>}
              {/* right axis = total live store base (zoomed to its own range) */}
              <text x={W - padR + 5} y={padT + 8} textAnchor="start" fill="var(--color-mint)" fillOpacity="0.85" fontSize="10">{tMax.toLocaleString()}</text>
              <text x={W - padR + 5} y={padT + ih} textAnchor="start" fill="var(--color-mint)" fillOpacity="0.5" fontSize="10">{tMin.toLocaleString()}</text>
              {/* hover column */}
              {hover != null && <rect x={xAt(hover)} y={padT} width={bw} height={ih} fill="var(--color-cream)" opacity="0.06" />}
              {/* diverging bars: new UP, churn DOWN */}
              {pts.map((p, i) => (
                <g key={p.date}>
                  <rect x={xAt(i) + bw * 0.2} width={bw * 0.6} y={baseY - upH(p.newStores)} height={upH(p.newStores)} fill="var(--color-cyan)" opacity={hover == null || hover === i ? 0.82 : 0.4} />
                  {p.churned > 0 && <rect x={xAt(i) + bw * 0.2} width={bw * 0.6} y={baseY} height={downH(p.churned)} fill="var(--color-orange)" opacity={hover == null || hover === i ? 0.85 : 0.4} />}
                </g>
              ))}
              {/* total live store base line (right scale) */}
              <polyline points={totLine} fill="none" stroke="var(--color-mint)" strokeWidth="2.5" strokeLinejoin="round" />
              {hp && <circle cx={xAt(hover ?? 0) + bw / 2} cy={yTot(hp.total)} r="3.5" fill="var(--color-mint)" />}
              {/* x labels */}
              {pts.map((p, i) => (i % labelEvery === 0 ? (
                <text key={`t${p.date}`} x={xAt(i) + bw / 2} y={H - 8} textAnchor="middle" fill="var(--color-cream)" fillOpacity="0.4" fontSize="9">{p.date.slice(0, period === "year" ? 4 : 7)}</text>
              ) : null))}
            </svg>
            {hp && (
              <div className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-lg border border-cream/20 bg-ink-deep/95 px-3 py-2 text-xs shadow-xl"
                style={{ left: `${Math.min(88, Math.max(12, ((xAt(hover ?? 0) + bw / 2) / W) * 100))}%`, top: 0 }}>
                <div className="font-semibold text-cream">{hp.date}</div>
                <div className="mt-1 text-cyan">+{hp.newStores.toLocaleString()} new</div>
                {hp.churned > 0 && <div className="text-orange">−{hp.churned.toLocaleString()} churned</div>}
                <div className="mt-0.5 text-mint">{hp.total.toLocaleString()} total stores</div>
              </div>
            )}
          </>
        )}
      </div>

      <p className="mt-2 text-xs text-cream/35">
        {data?.churnTrackedFrom
          ? `Churn tracked from ${data.churnTrackedFrom} — historical churn isn't available (a store's death is only seen once we're watching it).`
          : "Churn tracking builds as our liveness checks run — historical churn isn't available."}
        {data ? ` · ${data.totalNew.toLocaleString()} stores discovered in range.` : ""}
      </p>
    </div>
  );
}
