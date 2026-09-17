"use client";
import { useEffect, useRef, useState } from "react";
import type { ActivityEvent, ActivityAction } from "@/lib/ops";

// Colour + glyph + label per action. Liveness splits on the verdict (live vs dead/migrated).
const STYLE: Record<ActivityAction, { dot: string; glyph: string; label: string }> = {
  discovered: { dot: "bg-cyan", glyph: "+", label: "discovered" },
  launch: { dot: "bg-mint", glyph: "✦", label: "launch date" },
  payments: { dot: "bg-lilac", glyph: "✓", label: "payments" },
  liveness: { dot: "bg-cream/40", glyph: "·", label: "liveness" },
};

function ago(s: number): string {
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

/** Live activity feed — polls /api/ops/activity every 3s and shows what the swarm just touched.
 *  Each poll returns the freshest snapshot (last 15 min), so new rows surface at the top on their
 *  own; no worker changes — it reads the per-store timestamps the probes already write. */
export function ActivityFeed() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const newest = useRef<string>("");

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch("/api/ops/activity", { cache: "no-store" });
        if (!r.ok || !alive) return setConnected(false);
        const { events: fresh } = (await r.json()) as { events: ActivityEvent[] };
        if (!alive) return;
        setConnected(true);
        newest.current = fresh[0]?.ts ?? newest.current;
        setEvents(fresh.slice(0, 50));
      } catch {
        if (alive) setConnected(false);
      }
    };
    poll();
    const id = setInterval(poll, 6000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  return (
    <section className="mt-5 rounded-3xl border border-cream/12 bg-cream/[0.02] p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-cream/50">
          <span className={`h-2 w-2 rounded-full ${connected ? "bg-mint animate-pulse" : "bg-orange"}`} />
          Live activity
        </h2>
        <span className="text-[11px] tabular-nums text-cream/35">{events.length ? `${events.length} in last 15 min` : ""}</span>
      </div>
      {events.length === 0 ? (
        <p className="py-6 text-center text-sm text-cream/35">Waiting for activity… workers write here as they probe, check, and discover.</p>
      ) : (
        <ul className="max-h-[28rem] space-y-0.5 overflow-y-auto pr-1">
          {events.map((e) => {
            const st = STYLE[e.action];
            const dead = e.action === "liveness" && (e.detail === "dead" || e.detail === "migrated");
            return (
              <li key={`${e.domain}-${e.ts}`} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-cream/[0.03]">
                <span className={`grid h-4 w-4 shrink-0 place-items-center rounded-full text-[9px] font-bold text-ink ${dead ? "bg-orange" : st.dot}`}>{st.glyph}</span>
                <a href={`https://${e.domain}`} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate font-mono text-[13px] text-cream/85 hover:text-cream hover:underline">{e.domain}</a>
                <span className="hidden shrink-0 text-[10px] uppercase tracking-wide text-cream/30 sm:inline">{e.country}</span>
                <span className="shrink-0 text-xs text-cream/50">{st.label}</span>
                <span className="max-w-[10rem] shrink-0 truncate text-xs text-cream/40">{e.detail}</span>
                <span className="shrink-0 text-[10px] tabular-nums text-cream/25">{ago(e.ageSecs)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
