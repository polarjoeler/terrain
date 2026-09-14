"use client";

import { useEffect, useState, type MouseEvent } from "react";

type Point = { date: string; newStores: number; churned: number };
type Series = {
  period: string; points: Point[]; churnTrackedFrom: string | null;
  totalNew: number; totalChurn: number; currentTotal: number;
};
const PERIODS = [["day", "Day"], ["week", "Week"], ["month", "Month"], ["quarter", "Quarter"], ["year", "Year"]] as const;

/** Shopify-growth chart. The store base barely moves relative to its size, so the absolute
 *  total is a headline stat — not a line. The chart is the flow that actually varies: diverging
 *  bars, stores that truly launched per period (cyan, up) and churned (orange, down). "New" is
 *  keyed to real launch date (first product / launched_at), not when we discovered the store —
 *  so cert-renewal discovery floods don't inflate it. Filterable by period + custom range.
 *  Fetches paid-gated /api/growth. */
export function GrowthChart({ country, provider, platform, title = "Shopify store growth" }: { country?: string; provider?: string; platform?: string; title?: string }) {
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
      if (platform) p.set("platform", platform);
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
  }, [period, country, provider, platform, from, to]);

  const pts = data?.points ?? [];
  const noun = provider ? "merchants" : "stores";
  const W = 760, H = 280, padL = 44, padR = 14, padB = 40, padT = 14;
  const iw = W - padL - padR, ih = H - padT - padB;
  const maxNew = Math.max(1, ...pts.map((p) => p.newStores));
  const maxChurn = Math.max(0, ...pts.map((p) => p.churned));
  const baseY = padT + (maxNew / (maxNew + maxChurn || 1)) * ih;   // zero line: new above, churn below
  const bw = pts.length ? iw / pts.length : iw;
  const xAt = (i: number) => padL + i * bw;
  const upH = (v: number) => (v / maxNew) * (baseY - padT);
  const downH = (v: number) => (maxChurn ? (v / maxChurn) * (padT + ih - baseY) : 0);
  // Fewer, bigger, readable ticks. Weekly/daily need the actual day (Sep 7), not just the
  // month — otherwise every bar in a month reads identically. Parse the YYYY-MM-DD parts
  // directly (no Date()/timezone drift).
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const fmtTick = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    if (period === "year") return String(y);
    if (period === "quarter") return `Q${Math.floor((m - 1) / 3) + 1} '${String(y).slice(2)}`;
    if (period === "month") return `${MON[m - 1]} '${String(y).slice(2)}`;
    return `${MON[m - 1]} ${d}`;                       // day + week → "Sep 7"
  };
  const labelEvery = Math.max(1, Math.ceil(pts.length / (period === "week" || period === "day" ? 10 : 8)));
  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((((e.clientX - r.left) / r.width) * W - padL) / bw);
    setHover(i >= 0 && i < pts.length ? i : null);
  };
  const hp = hover != null ? pts[hover] : null;
  const net = data ? data.totalNew - data.totalChurn : 0;

  return (
    <div className="rounded-[2rem] border border-cream/12 bg-cream/[0.03] p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold">{title}</h3>
          <p className="mt-1 text-sm text-cream/45">
            {noun === "merchants" ? "Merchants" : "Stores"} that launched ↑ and churned ↓ per {period}.
          </p>
        </div>
        <div className="flex gap-1 rounded-full border border-cream/12 p-1">
          {PERIODS.map(([k, l]) => (
            <button key={k} onClick={() => setPeriod(k)}
              className={`rounded-full px-3 py-1 text-xs transition ${period === k ? "bg-cyan font-semibold text-cyan-deep" : "text-cream/50 hover:text-cream"}`}>{l}</button>
          ))}
        </div>
      </div>

      {/* headline figures */}
      <div className="mt-4 flex flex-wrap items-end gap-x-8 gap-y-3">
        <div>
          <div className="text-3xl font-semibold">{data ? data.currentTotal.toLocaleString() : "—"}</div>
          <div className="text-xs text-cream/45">live {noun} tracked</div>
        </div>
        <div>
          <div className="text-xl font-semibold text-cyan">+{data ? data.totalNew.toLocaleString() : "—"}</div>
          <div className="text-xs text-cream/45">launched, this range</div>
        </div>
        <div>
          <div className="text-xl font-semibold text-orange">−{data ? data.totalChurn.toLocaleString() : "—"}</div>
          <div className="text-xs text-cream/45">churned, this range</div>
        </div>
        <div>
          <div className={`text-xl font-semibold ${net >= 0 ? "text-mint" : "text-orange"}`}>{net >= 0 ? "+" : "−"}{Math.abs(net).toLocaleString()}</div>
          <div className="text-xs text-cream/45">net change</div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-cream/50">
        <span>Range:</span>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded border border-cream/15 bg-transparent px-2 py-1 text-cream" />
        <span>→</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="rounded border border-cream/15 bg-transparent px-2 py-1 text-cream" />
        {(from || to) && <button onClick={() => { setFrom(""); setTo(""); }} className="text-cream/40 hover:text-cream">clear</button>}
        <span className="ml-auto flex items-center gap-3">
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm bg-cyan opacity-80" />launched</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm bg-orange opacity-80" />churn</span>
        </span>
      </div>

      <div className="relative mt-4" onMouseLeave={() => setHover(null)}>
        {loading ? (
          <div className="grid h-64 place-items-center text-sm text-cream/40">Loading…</div>
        ) : err ? (
          <div className="grid h-64 place-items-center text-sm text-orange">{err}</div>
        ) : pts.length === 0 ? (
          <div className="grid h-64 place-items-center text-sm text-cream/40">No {noun} launched in this range yet.</div>
        ) : (
          <>
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full" onMouseMove={onMove}>
              {/* zero baseline + left axis */}
              <line x1={padL} y1={baseY} x2={W - padR} y2={baseY} stroke="var(--color-cream)" strokeOpacity="0.3" />
              <text x={padL - 6} y={padT + 5} textAnchor="end" fill="var(--color-cyan)" fillOpacity="0.8" fontSize="10">{maxNew.toLocaleString()}</text>
              <text x={padL - 6} y={baseY + 3} textAnchor="end" fill="var(--color-cream)" fillOpacity="0.45" fontSize="10">0</text>
              {maxChurn > 0 && <text x={padL - 6} y={padT + ih} textAnchor="end" fill="var(--color-orange)" fillOpacity="0.8" fontSize="10">{maxChurn.toLocaleString()}</text>}
              {/* hover column */}
              {hover != null && <rect x={xAt(hover)} y={padT} width={bw} height={ih} fill="var(--color-cream)" opacity="0.06" />}
              {/* diverging bars: new UP, churn DOWN */}
              {pts.map((p, i) => (
                <g key={p.date}>
                  <rect x={xAt(i) + bw * 0.18} width={bw * 0.64} y={baseY - upH(p.newStores)} height={upH(p.newStores)} rx="1.5" fill="var(--color-cyan)" opacity={hover == null || hover === i ? 0.85 : 0.38} />
                  {p.churned > 0 && <rect x={xAt(i) + bw * 0.18} width={bw * 0.64} y={baseY} height={downH(p.churned)} rx="1.5" fill="var(--color-orange)" opacity={hover == null || hover === i ? 0.85 : 0.38} />}
                </g>
              ))}
              {/* x labels — real dates, readable size; a tick mark anchors each */}
              {pts.map((p, i) => (i % labelEvery === 0 ? (
                <g key={`t${p.date}`}>
                  <line x1={xAt(i) + bw / 2} y1={padT + ih + 2} x2={xAt(i) + bw / 2} y2={padT + ih + 6} stroke="var(--color-cream)" strokeOpacity="0.25" />
                  <text x={xAt(i) + bw / 2} y={H - 12} textAnchor="middle" fill="var(--color-cream)" fillOpacity="0.6" fontSize="12">{fmtTick(p.date)}</text>
                </g>
              ) : null))}
              {(period === "week" || period === "day") && pts.length > 0 && (
                <text x={padL} y={H - 1} textAnchor="start" fill="var(--color-cream)" fillOpacity="0.35" fontSize="10">
                  {period === "week" ? "week beginning" : "day"}
                </text>
              )}
            </svg>
            {hp && (
              <div className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-lg border border-cream/20 bg-ink-deep/95 px-3 py-2 text-xs shadow-xl"
                style={{ left: `${Math.min(86, Math.max(14, ((xAt(hover ?? 0) + bw / 2) / W) * 100))}%`, top: 0 }}>
                <div className="font-semibold text-cream">{period === "week" ? `Week of ${fmtTick(hp.date)}, ${hp.date.slice(0, 4)}` : period === "day" ? `${fmtTick(hp.date)}, ${hp.date.slice(0, 4)}` : fmtTick(hp.date)}</div>
                <div className="mt-1 text-cyan">+{hp.newStores.toLocaleString()} launched</div>
                {hp.churned > 0 ? <div className="text-orange">−{hp.churned.toLocaleString()} churned</div> : <div className="text-cream/40">no churn</div>}
              </div>
            )}
          </>
        )}
      </div>

      <p className="mt-3 text-xs text-cream/35">
        {data?.churnTrackedFrom
          ? `"New" counts stores by real launch date (first product / launched_at), not when we discovered them. Churn tracked forward from ${data.churnTrackedFrom}. Recent launches lag slightly until each store is enriched.`
          : `"New" counts stores by real launch date, not discovery date. Recent launches lag slightly until each store is enriched.`}
      </p>
    </div>
  );
}
