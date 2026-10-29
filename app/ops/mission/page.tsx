import { redirect } from "next/navigation";
import { currentUser, isAdmin } from "@/lib/auth";
import { missionControl, type Pillar, type Metric } from "@/lib/mission";
import type { FleetMachine } from "@/lib/fleet";
import { AutoRefresh } from "../auto-refresh";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Mission Control" };

const ACCENT: Record<string, { text: string; dot: string; ring: string }> = {
  mint: { text: "text-mint", dot: "bg-mint", ring: "border-mint/25" },
  cyan: { text: "text-cyan", dot: "bg-cyan", ring: "border-cyan/25" },
  lilac: { text: "text-lilac", dot: "bg-lilac", ring: "border-lilac/25" },
  amber: { text: "text-amber", dot: "bg-amber", ring: "border-amber/25" },
};
const TONE: Record<string, string> = { good: "text-mint", warn: "text-amber", bad: "text-rose" };

const num = (n: number) => n.toLocaleString();

function ago(m: number | null): string {
  if (m == null) return "—";
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function MachineChip({ m }: { m: FleetMachine }) {
  const a = ACCENT[m.accent] ?? ACCENT.mint;
  const live = m.status === "active";
  const now = m.tasks.find((t) => t.ageMins != null && t.ageMins <= 10);
  return (
    <div className="flex min-w-[9rem] flex-1 items-center gap-2.5 rounded-2xl border border-cream/12 bg-cream/[0.03] px-3.5 py-2.5">
      <span className={`h-2 w-2 shrink-0 rounded-full ${a.dot} ${live ? "animate-pulse" : "opacity-40"}`} />
      <div className="min-w-0">
        <div className={`font-display text-lg leading-none ${a.text}`}>{m.name}</div>
        <div className="mt-1 truncate font-mono text-[10px] text-cream/40">
          {live && now ? `${now.task} · ${ago(now.ageMins)}` : m.status === "offline" ? "offline" : "standby"}
        </div>
      </div>
    </div>
  );
}

function MetricRow({ m }: { m: Metric }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-cream/8 py-1.5 first:border-0">
      <span className="text-[13px] text-cream/60">{m.label}</span>
      <span className="flex items-baseline gap-2">
        {m.pct != null && <span className="font-mono text-[11px] text-cream/40">{m.pct}%</span>}
        <span className={`font-mono text-sm tabular-nums ${m.tone ? TONE[m.tone] : "text-cream/90"}`}>{num(m.value)}</span>
      </span>
    </div>
  );
}

function PillarCard({ p }: { p: Pillar }) {
  const a = ACCENT[p.accent] ?? ACCENT.mint;
  return (
    <section className={`flex flex-col rounded-3xl border bg-cream/[0.03] p-5 ${a.ring}`}>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${a.dot}`} />
        <h2 className="font-mono text-[11px] uppercase tracking-[0.16em] text-cream/55">{p.title}</h2>
      </div>
      <div className={`mt-2 font-display text-2xl ${a.text}`}>{p.headline}</div>
      <div className="mt-3">{p.metrics.map((m) => <MetricRow key={m.label} m={m} />)}</div>
      <div className="mt-auto pt-3">
        {p.flag && <div className={`font-mono text-[11px] ${TONE[p.flag.tone]}`}>● {p.flag.text}</div>}
        <div className="mt-1 font-mono text-[10px] text-cream/35">{p.owners}</div>
      </div>
    </section>
  );
}

export default async function MissionControlPage() {
  const email = await currentUser();
  if (!isAdmin(email)) redirect("/login");
  const { machines, alerts, pillars } = await missionControl();

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <AutoRefresh seconds={15} />
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-cream/40">ZA · KE · NG · against our five priorities</div>
          <h1 className="font-display text-3xl text-cream"><span className="text-mint">Mission</span> Control</h1>
        </div>
        <div className="flex items-center gap-2 font-mono text-[11px] text-cream/45">
          <span className="h-2 w-2 animate-pulse rounded-full bg-mint" /> live · 15s
        </div>
      </header>

      {alerts.length > 0 && (
        <div className="mb-5 rounded-2xl border border-rose/30 bg-rose/[0.06] px-4 py-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-rose/80">Health alerts</div>
          <div className="mt-1.5 space-y-1">
            {alerts.map((al) => (
              <div key={al.check} className="text-[13px] text-cream/80"><span className="font-mono text-rose/90">{al.check}</span> — {al.detail}</div>
            ))}
          </div>
        </div>
      )}

      <div className="mb-5 flex flex-wrap gap-2.5">
        {machines.map((m) => <MachineChip key={m.key} m={m} />)}
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {pillars.map((p) => <PillarCard key={p.key} p={p} />)}
      </div>
    </main>
  );
}
