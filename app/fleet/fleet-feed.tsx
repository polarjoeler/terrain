"use client";
import { useEffect, useRef, useState } from "react";
import type { FleetEvent, FleetKey } from "@/lib/fleet";

const MACHINE: Record<FleetKey, { label: string; cls: string }> = {
  rex: { label: "REX", cls: "text-mint" },
  lucy: { label: "LUCY", cls: "text-cyan" },
  chad: { label: "CHAD", cls: "text-lilac" },
};

function ago(s: number): string {
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/** Live feed — polls /api/fleet/activity every 5s and renders the freshest machine-attributed
 *  events (newest first). Seeded by the server with `initial` so it's full on first paint. */
export function FleetFeed({ initial }: { initial: FleetEvent[] }) {
  const [events, setEvents] = useState<FleetEvent[]>(initial);
  const [live, setLive] = useState(true);
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch("/api/fleet/activity", { cache: "no-store" });
        if (!alive) return;
        if (!r.ok) { setLive(false); return; }
        const { events: fresh } = (await r.json()) as { events: FleetEvent[] };
        if (!alive) return;
        setLive(true);
        setEvents(fresh);
      } catch {
        if (alive) setLive(false);
      }
    };
    const id = setInterval(poll, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // mark the newest few as fresh so they get a brief highlight
  const newestTs = events[0]?.ts ?? "";

  return (
    <section className="rounded-3xl border border-cream/12 bg-ink/40 overflow-hidden">
      <div className="flex items-center gap-2 border-b border-cream/10 bg-cream/[0.03] px-4 py-3">
        <span className={`h-2 w-2 rounded-full ${live ? "bg-mint animate-pulse" : "bg-cream/30"}`} />
        <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-cream/70">Live activity</h2>
        <span className="ml-auto font-mono text-[11px] text-cream/35">Rex · Lucy · Chad · tagged by machine · polls 5s</span>
      </div>
      <div className="max-h-[320px] overflow-y-auto px-3 py-2 font-mono text-[12.5px] leading-relaxed">
        {events.length === 0 && <div className="px-1 py-6 text-center text-cream/30">waiting for activity…</div>}
        {events.map((e) => {
          const m = MACHINE[e.machine];
          const key = e.ts + e.domain + e.lane;
          const fresh = e.ts === newestTs && !seen.current.has(key);
          seen.current.add(key);
          return (
            <div key={key} className={`flex items-baseline gap-2.5 whitespace-nowrap overflow-hidden px-1 py-[3px] ${fresh ? "bg-cream/[0.04]" : ""}`}>
              <span className="w-8 shrink-0 text-cream/30">{ago(e.ageSecs)}</span>
              <span className={`w-11 shrink-0 font-semibold ${m.cls}`}>{m.label}</span>
              <span className="shrink-0 rounded border border-cream/15 px-1.5 text-[9px] uppercase tracking-wide text-cream/45">{e.lane}</span>
              <span className="truncate text-cream/85">{e.domain}</span>
              <span className={`ml-auto shrink-0 ${e.detail.includes("skipped") ? "text-cream/35" : "text-cream/55"}`}>{e.detail}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
