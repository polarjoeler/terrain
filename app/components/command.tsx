"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { DayBucket } from "@/lib/overview";

const reduce = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion:reduce)").matches;

/** Count a number up on mount (respecting reduced-motion). */
function useCountUp(to: number) {
  const [v, setV] = useState(reduce() ? to : 0);
  useEffect(() => {
    if (reduce()) { setV(to); return; }
    let raf = 0; const t0 = performance.now(); const dur = 700 + Math.min(600, to);
    const tick = (t: number) => { const p = Math.min(1, (t - t0) / dur); setV(Math.round((1 - Math.pow(1 - p, 3)) * to)); if (p < 1) raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to]);
  return v;
}

const ACCENT: Record<string, { text: string; bar: string }> = {
  mint: { text: "text-mint", bar: "bg-mint" },
  cyan: { text: "text-cyan", bar: "bg-cyan" },
  lilac: { text: "text-lilac", bar: "bg-lilac" },
  orange: { text: "text-orange", bar: "bg-orange" },
};

/** A "while you were away" stat: big count-up number + a week-over-week delta. `goodUp=false`
 *  flips the colour (for churn, up is bad). Optional href makes the whole tile a drill-through. */
export function StatChip({ label, value, prev, accent = "mint", sub, href, goodUp = true }: {
  label: string; value: number; prev?: number; accent?: keyof typeof ACCENT | string; sub?: string; href?: string; goodUp?: boolean;
}) {
  const shown = useCountUp(value);
  const a = ACCENT[accent] ?? ACCENT.mint;
  const delta = prev == null ? null : value - prev;
  const up = (delta ?? 0) > 0;
  const good = delta == null || delta === 0 ? "text-cream/40" : (up === goodUp ? "text-mint" : "text-orange");
  const inner = (
    <div className="relative overflow-hidden rounded-2xl border border-cream/10 bg-cream/[0.025] p-4 transition hover:border-cream/25">
      <div className={`flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide ${a.text}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${a.bar}`} />{label}
      </div>
      <div className="mt-2 font-display text-[2.1rem] font-bold leading-none tabular-nums text-cream">{shown.toLocaleString()}</div>
      <div className="mt-1 flex items-center gap-1.5 text-xs">
        {delta != null && <span className={`font-mono font-semibold ${good}`}>{delta === 0 ? "±0" : up ? `▲ +${Math.abs(delta).toLocaleString()}` : `▼ −${Math.abs(delta).toLocaleString()}`}</span>}
        <span className="text-cream/40">{delta != null ? "vs last week" : sub}</span>
      </div>
      <span className={`absolute inset-x-0 bottom-0 h-[3px] ${a.bar} opacity-90`} />
    </div>
  );
  return href ? <Link href={href} className="block">{inner}</Link> : inner;
}

const COLORS = { shopify: "var(--color-cyan)", woo: "var(--color-lilac)", other: "var(--color-mint)" };

/** Daily launch stream — stacked bars, one per day, over the window. Honest launch-dated data
 *  (date-granular), animated growing in on mount. */
export function LaunchTrend({ data }: { data: DayBucket[] }) {
  const [m, setM] = useState(false);
  const [win, setWin] = useState(30);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => { const id = requestAnimationFrame(() => requestAnimationFrame(() => setM(true))); return () => cancelAnimationFrame(id); }, []);
  if (!data.length) return <p className="py-10 text-center text-sm text-cream/35">Launch data is warming up.</p>;
  const shown = data.slice(-win);
  const totals = shown.map((d) => d.shopify + d.woo + d.other);
  const max = Math.max(1, ...totals);
  const peak = Math.max(...totals);
  const W = 760, H = 150, gap = shown.length > 45 ? 1 : 2;
  const bw = (W - gap * (shown.length - 1)) / shown.length;
  const animated = reduce() || m;
  const fmtDay = (iso: string) => new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const hd = hover != null ? shown[hover] : null;
  const hx = hover != null ? ((hover * (bw + gap) + bw / 2) / W) * 100 : 0;
  return (
    <div className="relative">
      <div className="mb-2 flex items-center justify-end gap-1">
        {[30, 90].map((w) => (
          <button key={w} onClick={() => { setWin(w); setHover(null); }} className={`rounded-full px-2.5 py-1 font-mono text-[11px] transition ${win === w ? "bg-cream/10 text-cream" : "text-cream/45 hover:text-cream"}`}>{w}d</button>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: "auto" }} preserveAspectRatio="none" role="img" aria-label={`Daily store launches over the last ${win} days`} onMouseLeave={() => setHover(null)}>
        {shown.map((dd, i) => {
          const x = i * (bw + gap);
          let y = H;
          const segs: [number, string][] = [["shopify", COLORS.shopify], ["woo", COLORS.woo], ["other", COLORS.other]].map(([k, c]) => [dd[k as "shopify"], c]);
          return (
            <g key={dd.day} onMouseEnter={() => setHover(i)}>
              {hover === i && <rect x={x - gap / 2} y={0} width={bw + gap} height={H} fill="var(--color-cream)" opacity="0.06" />}
              {segs.map(([v, c], si) => {
                const h = animated ? (v / max) * (H - 6) : 0;
                y -= h;
                return <rect key={si} x={x} y={y} width={bw} height={Math.max(0, h)} fill={c} rx={bw > 6 ? 1.5 : 0}
                  style={{ transition: `y .7s ${0.1 + i * 0.012}s cubic-bezier(.2,.8,.2,1), height .7s ${0.1 + i * 0.012}s cubic-bezier(.2,.8,.2,1)` }} />;
              })}
            </g>
          );
        })}
      </svg>
      {hd && (
        <div className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-cream/15 bg-ink-deep/95 px-2.5 py-1.5 text-[11px] shadow-xl" style={{ left: `${hx}%` }}>
          <div className="font-mono text-cream/90">{fmtDay(hd.day)}</div>
          <div className="mt-0.5 font-mono text-cream/55">{(hd.shopify + hd.woo + hd.other).toLocaleString()} launches</div>
          <div className="mt-1 space-y-0.5">
            {([["Shopify", hd.shopify, COLORS.shopify], ["Woo", hd.woo, COLORS.woo], ["Other", hd.other, COLORS.other]] as [string, number, string][]).filter(([, v]) => v > 0).map(([l, v, c]) => (
              <div key={l} className="flex items-center gap-2"><i className="inline-block h-1.5 w-1.5 shrink-0 rounded-sm" style={{ background: c }} /><span className="text-cream/70">{l}</span><span className="ml-auto font-mono text-cream/90">{v}</span></div>
            ))}
          </div>
        </div>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-cream/55">
        <span className="flex items-center gap-1.5"><i className="inline-block h-2 w-2 rounded-sm" style={{ background: COLORS.shopify }} />Shopify</span>
        <span className="flex items-center gap-1.5"><i className="inline-block h-2 w-2 rounded-sm" style={{ background: COLORS.woo }} />WooCommerce</span>
        <span className="flex items-center gap-1.5"><i className="inline-block h-2 w-2 rounded-sm" style={{ background: COLORS.other }} />Other CMS</span>
        <span className="ml-auto font-mono text-cream/35">peak {peak}/day · last {win} days</span>
      </div>
    </div>
  );
}
