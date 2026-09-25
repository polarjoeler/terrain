"use client";

import { useEffect, useState, type MouseEvent } from "react";

type Point = {
  date: string; newStores: number; switchedIn: number;
  churnedDeath: number; churnedSwitch: number; churned: number;
};
type Series = {
  period: string; points: Point[]; churnTrackedFrom: string | null;
  totalNew: number; totalSwitchIn: number;
  totalChurnDeath: number; totalChurnSwitch: number; totalChurn: number;
  currentTotal: number; hasSwitchFlows: boolean;
};
const PERIODS = [["day", "Day"], ["week", "Week"], ["month", "Month"], ["quarter", "Quarter"], ["year", "Year"]] as const;

/** Shopify-growth chart. The store base barely moves relative to its size, so the absolute
 *  total is a headline stat — not a line. The chart is the flow that actually varies: diverging
 *  bars, stores that truly launched per period (cyan, up) and churned (orange, down). "New" is
 *  keyed to real launch date (first product / launched_at), not when we discovered the store —
 *  so cert-renewal discovery floods don't inflate it. Filterable by period + custom range.
 *
 *  PROVIDER view (a provider is passed → data.hasSwitchFlows): the flow becomes a merchant
 *  win/loss ledger. Adds split into launched (cyan) + switched-IN from a rival (mint); churn
 *  splits into DEFECTED to a competitor (orange — a live store that dropped this gateway) +
 *  store DIED (lilac). Defection never lands in churn_log (the store is still alive), so without
 *  this split the provider chart showed zero churn while the switches panel listed real losses.
 *  Fetches paid-gated /api/growth. */
export function GrowthChart({ country, provider, platform, period: periodProp, from: fromProp, to: toProp, title = "Shopify store growth" }: { country?: string; provider?: string; platform?: string; period?: string; from?: string; to?: string; title?: string }) {
  // When `periodProp` is passed the parent's period control drives the chart (no duplicate
  // selector — the redundancy we're removing); standalone (provider pages) it keeps its own.
  const controlled = !!periodProp;
  const [period, setPeriod] = useState(periodProp ?? "month");
  useEffect(() => { if (periodProp) setPeriod(periodProp); }, [periodProp]);
  // Custom date range: when the parent supplies from/to (the one report-wide date filter) the
  // chart follows it and hides its own picker; standalone it keeps its own range inputs.
  const rangeControlled = fromProp !== undefined || toProp !== undefined;
  const [fromState, setFrom] = useState("");
  const [toState, setTo] = useState("");
  const from = rangeControlled ? (fromProp ?? "") : fromState;
  const to = rangeControlled ? (toProp ?? "") : toState;
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
  const bands = !!data?.hasSwitchFlows;   // provider view → show switched-in / defected / died split
  const W = 760, H = 280, padL = 44, padR = 14, padB = 40, padT = 14;
  const iw = W - padL - padR, ih = H - padT - padB;
  // Stacks: adds = launched + switched-in (up); churn = defected + died (down).
  const addOf = (p: Point) => p.newStores + (bands ? p.switchedIn : 0);
  const maxNew = Math.max(1, ...pts.map(addOf));
  const maxChurn = Math.max(0, ...pts.map((p) => p.churned));
  const baseY = padT + (maxNew / (maxNew + maxChurn || 1)) * ih;   // zero line: new above, churn below
  const bw = pts.length ? iw / pts.length : iw;
  const xAt = (i: number) => padL + i * bw;
  const upH = (v: number) => (v / maxNew) * (baseY - padT);
  const downH = (v: number) => (maxChurn ? (v / maxChurn) * (padT + ih - baseY) : 0);
  const bx = (i: number) => xAt(i) + bw * 0.18, bwid = bw * 0.64;
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
  const grossAdd = data ? data.totalNew + (bands ? data.totalSwitchIn : 0) : 0;
  const net = data ? grossAdd - data.totalChurn : 0;
  const dim = (i: number) => (hover == null || hover === i ? 0.85 : 0.38);

  return (
    <div className="rounded-[2rem] border border-cream/12 bg-cream/[0.03] p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold">{title}</h3>
          <p className="mt-1 text-sm text-cream/45">
            {bands
              ? `Merchants gained ↑ (launched + switched in) and lost ↓ (defected + died) per ${period}.`
              : `${noun === "merchants" ? "Merchants" : "Stores"} that launched ↑ and churned ↓ per ${period}.`}
          </p>
        </div>
        {!controlled && (
          <div className="flex gap-1 rounded-full border border-cream/12 p-1">
            {PERIODS.map(([k, l]) => (
              <button key={k} onClick={() => setPeriod(k)}
                className={`rounded-full px-3 py-1 text-xs transition ${period === k ? "bg-cyan font-semibold text-cyan-deep" : "text-cream/50 hover:text-cream"}`}>{l}</button>
            ))}
          </div>
        )}
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
        {bands && (
          <div>
            <div className="text-xl font-semibold text-mint">+{data ? data.totalSwitchIn.toLocaleString() : "—"}</div>
            <div className="text-xs text-cream/45">switched in</div>
          </div>
        )}
        {bands ? (<>
          <div>
            <div className="text-xl font-semibold text-orange">−{data ? data.totalChurnSwitch.toLocaleString() : "—"}</div>
            <div className="text-xs text-cream/45">defected to a rival</div>
          </div>
          <div>
            <div className="text-xl font-semibold text-lilac">−{data ? data.totalChurnDeath.toLocaleString() : "—"}</div>
            <div className="text-xs text-cream/45">store died</div>
          </div>
        </>) : (
          <div>
            <div className="text-xl font-semibold text-orange">−{data ? data.totalChurn.toLocaleString() : "—"}</div>
            <div className="text-xs text-cream/45">churned, this range</div>
          </div>
        )}
        <div>
          <div className={`text-xl font-semibold ${net >= 0 ? "text-mint" : "text-orange"}`}>{net >= 0 ? "+" : "−"}{Math.abs(net).toLocaleString()}</div>
          <div className="text-xs text-cream/45">net change</div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-cream/50">
        {!rangeControlled && (<>
          <span>Range:</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded border border-cream/15 bg-transparent px-2 py-1 text-cream" />
          <span>→</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="rounded border border-cream/15 bg-transparent px-2 py-1 text-cream" />
          {(from || to) && <button onClick={() => { setFrom(""); setTo(""); }} className="text-cream/40 hover:text-cream">clear</button>}
        </>)}
        {rangeControlled && (from || to) && <span className="text-cream/45">Showing {from || "start"} → {to || "now"}</span>}
        <span className="ml-auto flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm bg-cyan opacity-80" />launched</span>
          {bands && <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm bg-mint opacity-80" />switched in</span>}
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm bg-orange opacity-80" />{bands ? "defected" : "churn"}</span>
          {bands && <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm bg-lilac opacity-80" />died</span>}
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
              {/* diverging bars: adds UP (launched, then switched-in stacked), churn DOWN (defected near
                  baseline, then died below). On the platform view (no bands) it's the classic two-bar chart. */}
              {pts.map((p, i) => (
                <g key={p.date}>
                  {/* UP: launched */}
                  <rect x={bx(i)} width={bwid} y={baseY - upH(p.newStores)} height={upH(p.newStores)} rx="1.5" fill="var(--color-cyan)" opacity={dim(i)} />
                  {/* UP: switched in (stacked above launched) */}
                  {bands && p.switchedIn > 0 && (
                    <rect x={bx(i)} width={bwid} y={baseY - upH(p.newStores + p.switchedIn)} height={upH(p.switchedIn)} rx="1.5" fill="var(--color-mint)" opacity={dim(i)} />
                  )}
                  {bands ? (<>
                    {/* DOWN: defected (nearest baseline) */}
                    {p.churnedSwitch > 0 && <rect x={bx(i)} width={bwid} y={baseY} height={downH(p.churnedSwitch)} rx="1.5" fill="var(--color-orange)" opacity={dim(i)} />}
                    {/* DOWN: died (below defected) */}
                    {p.churnedDeath > 0 && <rect x={bx(i)} width={bwid} y={baseY + downH(p.churnedSwitch)} height={downH(p.churnedDeath)} rx="1.5" fill="var(--color-lilac)" opacity={dim(i)} />}
                  </>) : (
                    p.churned > 0 && <rect x={bx(i)} width={bwid} y={baseY} height={downH(p.churned)} rx="1.5" fill="var(--color-orange)" opacity={dim(i)} />
                  )}
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
                {bands ? (<>
                  {hp.switchedIn > 0 && <div className="text-mint">+{hp.switchedIn.toLocaleString()} switched in</div>}
                  {hp.churnedSwitch > 0 && <div className="text-orange">−{hp.churnedSwitch.toLocaleString()} defected</div>}
                  {hp.churnedDeath > 0 && <div className="text-lilac">−{hp.churnedDeath.toLocaleString()} died</div>}
                  {hp.churned === 0 && hp.switchedIn === 0 && <div className="text-cream/40">no churn or switch-ins</div>}
                </>) : (
                  hp.churned > 0 ? <div className="text-orange">−{hp.churned.toLocaleString()} churned</div> : <div className="text-cream/40">no churn</div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <p className="mt-3 text-xs text-cream/35">
        {bands
          ? `Gains = stores that launched on this gateway (real launch date) + live stores that switched IN from a rival. Losses = live stores that DEFECTED to a competitor (from the switches log) + stores that DIED while on this gateway${data?.churnTrackedFrom ? `, tracked forward from ${data.churnTrackedFrom}` : ""}. A defection never appears as a store death — the merchant is still trading, just not with this gateway.`
          : data?.churnTrackedFrom
          ? `"New" counts stores by real launch date (first product / launched_at), not when we discovered them. Churn tracked forward from ${data.churnTrackedFrom}. Recent launches lag slightly until each store is enriched.`
          : `"New" counts stores by real launch date, not discovery date. Recent launches lag slightly until each store is enriched.`}
      </p>
    </div>
  );
}
