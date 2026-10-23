import { redirect } from "next/navigation";
import { currentUser, isAdmin } from "@/lib/auth";
import { fleetMachines, fleetActivity, type FleetMachine, type FleetStatus } from "@/lib/fleet";
import { AutoRefresh } from "../ops/auto-refresh";
import { FleetFeed } from "./fleet-feed";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Fleet" };

const ACCENT: Record<string, { text: string; dot: string }> = {
  mint: { text: "text-mint", dot: "bg-mint" },
  cyan: { text: "text-cyan", dot: "bg-cyan" },
  lilac: { text: "text-lilac", dot: "bg-lilac" },
};
const STATUS: Record<FleetStatus, { label: string; cls: string }> = {
  active: { label: "Active", cls: "text-mint" },
  idle: { label: "Standby", cls: "text-cream/50" },
  offline: { label: "Offline", cls: "text-cream/30" },
};

function ago(m: number | null): string {
  if (m == null) return "—";
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

function MachineCard({ m }: { m: FleetMachine }) {
  const a = ACCENT[m.accent] ?? ACCENT.mint;
  const s = STATUS[m.status];
  const running = m.tasks.filter((t) => t.ageMins != null && t.ageMins <= 10);
  const recent = m.tasks.filter((t) => !running.includes(t)).slice(0, 4);
  return (
    <section className="flex flex-col rounded-3xl border border-cream/12 bg-cream/[0.03] p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className={`h-2.5 w-2.5 rounded-full ${a.dot} ${m.status === "active" ? "animate-pulse" : "opacity-50"}`} />
          <span className={`font-display text-2xl ${a.text}`}>{m.name}</span>
        </div>
        <span className={`font-mono text-[11px] font-semibold uppercase tracking-wide ${s.cls}`}>{s.label}</span>
      </div>
      <div className="mt-1 font-mono text-[11px] text-cream/40">{m.hw}</div>

      {running.length > 0 && (
        <div className="mt-4">
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-cream/40">Doing now</div>
          <div className="mt-2 space-y-1.5">
            {running.map((t) => (
              <div key={t.task} className="flex items-baseline gap-2 text-sm">
                <span className={`h-1.5 w-1.5 rounded-full ${a.dot} animate-pulse`} />
                <span className="font-medium text-cream/90">{t.task}</span>
                <span className="ml-auto font-mono text-[11px] text-cream/40">{ago(t.ageMins)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {recent.length > 0 && (
        <div className="mt-4">
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-cream/40">Recent</div>
          <div className="mt-2 space-y-1">
            {recent.map((t) => (
              <div key={t.task} className="flex items-baseline gap-2 text-[13px] text-cream/55">
                <span className="h-1.5 w-1.5 rounded-full bg-cream/25" />
                <span>{t.task}</span>
                <span className="ml-auto font-mono text-[11px] text-cream/35">{ago(t.ageMins)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {m.status === "offline" && running.length === 0 && (
        <div className="mt-4 font-mono text-[12px] text-cream/35">No recent heartbeat — likely asleep or off-network.</div>
      )}
    </section>
  );
}

export default async function FleetPage() {
  const email = await currentUser();
  if (!isAdmin(email)) redirect("/login");

  const [machines, activity] = await Promise.all([
    fleetMachines().catch(() => []),
    fleetActivity(40).catch(() => []),
  ]);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <AutoRefresh seconds={15} />
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-cream/40">Discovery &amp; enrichment pipeline</div>
          <h1 className="font-display text-3xl text-cream">
            <span className="text-mint">Terrain</span> Fleet
          </h1>
        </div>
        <div className="flex items-center gap-2 font-mono text-[11px] text-cream/45">
          <span className="h-2 w-2 animate-pulse rounded-full bg-mint" />
          live · cards refresh 15s · one home IP shared across Rex · Lucy · Chad
        </div>
      </header>

      <div className="grid gap-4 md:grid-cols-3">
        {machines.map((m) => <MachineCard key={m.key} m={m} />)}
      </div>

      <div className="mt-5">
        <FleetFeed initial={activity} />
      </div>
    </main>
  );
}
