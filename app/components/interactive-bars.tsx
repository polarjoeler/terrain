"use client";

import { useEffect, useState } from "react";

export type BarItem = { label: string; count: number; pct: number };

const FILL: Record<string, string> = {
  orange: "bg-orange", cyan: "bg-cyan", mint: "bg-mint", lilac: "bg-lilac",
};

/** Animated, hoverable, optionally-clickable horizontal bar list — the shared
 *  "alive report" primitive. Bars grow on mount; click a bar to select it
 *  (cross-filter/drill-in via onSelect); the active bar is highlighted. */
export function InteractiveBars({
  data, tone = "orange", activeLabel, onSelect, initialLimit = 8,
}: {
  data: BarItem[];
  tone?: string;
  activeLabel?: string | null;
  onSelect?: (label: string) => void;
  initialLimit?: number;
}) {
  const [mounted, setMounted] = useState(false);
  const [all, setAll] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setMounted(true)));
    return () => cancelAnimationFrame(id);
  }, []);

  const max = Math.max(1, ...data.map((d) => d.count));
  const shown = all ? data : data.slice(0, initialLimit);
  const fill = FILL[tone] ?? "bg-orange";
  const clickable = !!onSelect;

  if (data.length === 0) return <p className="text-sm text-cream/40">No data yet.</p>;

  return (
    <div>
      <div className={`space-y-2 ${all && data.length > 12 ? "max-h-96 overflow-y-auto pr-1" : ""}`}>
        {shown.map((i) => {
          const active = activeLabel === i.label;
          return (
            <button
              key={i.label}
              type="button"
              onClick={clickable ? () => onSelect!(i.label) : undefined}
              title={`${i.label}: ${i.count.toLocaleString()} (${i.pct}%)`}
              className={`flex w-full items-center gap-3 rounded-lg px-1.5 py-1 text-left transition ${
                clickable ? "cursor-pointer hover:bg-cream/[0.06]" : "cursor-default"
              } ${active ? "bg-cyan/[0.12]" : ""}`}
            >
              <span className={`w-28 shrink-0 truncate text-sm ${active ? "text-cream" : "text-cream/75"}`}>{i.label}</span>
              <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-cream/[0.08]">
                <span
                  className={`block h-full rounded-full ${fill} ${active ? "" : "opacity-90"}`}
                  style={{
                    width: mounted ? `${Math.max(2, (i.count / max) * 100)}%` : "0%",
                    transition: "width .9s cubic-bezier(.2,.8,.2,1)",
                  }}
                />
              </span>
              <span className="w-9 shrink-0 text-right text-sm tabular-nums text-cream/70">{i.pct}%</span>
              <span className="w-12 shrink-0 text-right text-xs tabular-nums text-cream/40">{i.count.toLocaleString()}</span>
            </button>
          );
        })}
      </div>
      {data.length > initialLimit && (
        <button onClick={() => setAll((a) => !a)} className="mt-3 text-sm font-medium text-cream/50 transition hover:text-cream">
          {all ? "Show top " + initialLimit : `See all ${data.length} →`}
        </button>
      )}
    </div>
  );
}

/** Count-up number (for hero stats). Respects reduced-motion. */
export function CountUp({ value, className }: { value: number; className?: string }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setN(value); return;
    }
    const dur = 1000, t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      setN(Math.round(value * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <span className={className}>{n.toLocaleString()}</span>;
}
