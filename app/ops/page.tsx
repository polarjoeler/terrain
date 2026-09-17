import { redirect } from "next/navigation";
import Link from "next/link";
import { currentUser, isAdmin } from "@/lib/auth";
import { opsStatus, type Heartbeat } from "@/lib/ops";
import { AutoRefresh } from "./auto-refresh";
import { ActivityFeed } from "./activity-feed";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Ops" };

function ago(m: number | null): string {
  if (m == null) return "no data";
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

function Stat({ n, label, sub, tone = "cream" }: { n: string; label: string; sub?: string; tone?: string }) {
  const c = tone === "mint" ? "text-mint" : tone === "orange" ? "text-orange" : tone === "cyan" ? "text-cyan" : "text-cream";
  return (
    <div className="rounded-2xl border border-cream/12 bg-cream/[0.03] p-4">
      <div className={`font-display text-3xl leading-none ${c}`}>{n}</div>
      <div className="mt-1.5 text-xs font-medium uppercase tracking-wide text-cream/45">{label}</div>
      {sub && <div className="mt-0.5 text-[11px] text-cream/35">{sub}</div>}
    </div>
  );
}

function MachineRow({ h }: { h: Heartbeat }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-cream/[0.07] py-3 last:border-0">
      <div className="flex items-center gap-2.5">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${h.ok ? "bg-mint" : "bg-orange"} ${h.ok ? "animate-pulse" : ""}`} />
        <div>
          <div className="text-sm font-medium text-cream/85">{h.label}</div>
          <div className="text-[11px] text-cream/40">{h.detail}</div>
        </div>
      </div>
      <div className={`text-sm tabular-nums ${h.ok ? "text-cream/60" : "text-orange"}`}>{ago(h.ageMins)}</div>
    </div>
  );
}

export default async function OpsPage() {
  const email = await currentUser();
  if (!email) redirect("/login");
  if (!isAdmin(email)) redirect("/dashboard");

  const s = await opsStatus().catch(() => null);
  if (!s) return <main className="grid min-h-screen place-items-center text-cream/50">Couldn&rsquo;t load status.</main>;

  const allOk = s.machines.every((m) => m.ok);

  return (
    <main className="min-h-screen px-4 py-6">
      <AutoRefresh seconds={60} />
      <div className="mx-auto max-w-lg">
        <div className="flex items-center justify-between">
          <h1 className="font-display text-2xl text-cream">Terrain Ops</h1>
          <span className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ${allOk ? "border-mint/30 bg-mint/10 text-mint" : "border-orange/30 bg-orange/10 text-orange"}`}>
            <span className={`h-2 w-2 rounded-full ${allOk ? "bg-mint" : "bg-orange"}`} />
            {allOk ? "All systems live" : "Needs attention"}
          </span>
        </div>
        <p className="mt-1 text-xs text-cream/35">Live · refreshes every 60s · {new Date(s.at).toLocaleTimeString()}</p>

        {/* Machine heartbeats — the "is everything running" glance */}
        <section className="mt-5 rounded-3xl border border-cream/12 bg-cream/[0.02] p-4">
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-cream/50">Machines</h2>
          {s.machines.map((m) => <MachineRow key={m.label} h={m} />)}
        </section>

        {/* Live activity feed — watch the swarm work in real time */}
        <ActivityFeed />

        {/* Two tracks per platform — Coverage (our progress) vs Market movement (best estimate) */}
        <section className="mt-5 space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-cream/50">Coverage &amp; market · by platform</h2>
          {s.platforms.map((pf) => (
            <div key={pf.label} className="rounded-3xl border border-cream/12 bg-cream/[0.02] p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-cream">{pf.label}</span>
                <span className="text-[11px] text-cream/40">{pf.tracked.toLocaleString()} tracked</span>
              </div>
              {/* Track A — our coverage */}
              <div className="mt-2 text-[10px] font-semibold uppercase tracking-wide text-cyan">Our coverage</div>
              <div className="mt-1 grid grid-cols-4 gap-2">
                {[
                  { n: pf.live.toLocaleString(), l: "live" },
                  { n: `${pf.scanFreshPct}%`, l: "scan ≤30d" },
                  { n: `${pf.paymentPct}%`, l: "payments" },
                  { n: `${pf.launchPct}%`, l: "launch date" },
                ].map((x) => (
                  <div key={x.l}>
                    <div className="font-display text-xl leading-none text-cream">{x.n}</div>
                    <div className="mt-0.5 text-[10px] uppercase tracking-wide text-cream/40">{x.l}</div>
                  </div>
                ))}
              </div>
              {/* Track B — market movement (last 30 days, real dates) */}
              <div className="mt-3 text-[10px] font-semibold uppercase tracking-wide text-mint">Market · last 30d</div>
              <div className="mt-1 flex items-center gap-5">
                <div><span className="font-display text-xl text-mint">+{pf.launched30d.toLocaleString()}</span> <span className="text-[11px] text-cream/45">launched</span></div>
                <div><span className="font-display text-xl text-orange">−{pf.churned30d.toLocaleString()}</span> <span className="text-[11px] text-cream/45">churned{pf.label === "WooCommerce" ? " (n/a yet)" : ""}</span></div>
                <div className="ml-auto text-[11px] text-cream/40">net {pf.launched30d - pf.churned30d >= 0 ? "+" : "−"}{Math.abs(pf.launched30d - pf.churned30d).toLocaleString()}</div>
              </div>
            </div>
          ))}
        </section>

        {/* Key metrics */}
        <section className="mt-5 grid grid-cols-2 gap-3">
          <Stat n={s.woo.total.toLocaleString()} label="Woo confirmed" sub={`${s.woo.cohortReal.toLocaleString()} real in 2019 cohort`} tone="cyan" />
          <Stat n={`${s.payments.coverage}%`} label="Payment coverage" sub={`${s.payments.backlog.toLocaleString()} tail · ${s.payments.probed12h.toLocaleString()} probed/12h`} tone="mint" />
          <Stat n={s.launched.since.toLocaleString()} label="ZA launched (tracked)" sub={`+${s.launched.filled12h.toLocaleString()} dates filled/12h`} />
          <Stat n={s.discovery.today.toLocaleString()} label="Discovered today" sub={`${s.discovery.yesterday.toLocaleString()} yesterday`} tone="orange" />
        </section>

        <div className="mt-6 flex justify-center gap-4 text-xs text-cream/40">
          <Link href="/insights" className="hover:text-cream">Insights →</Link>
          <Link href="/dashboard" className="hover:text-cream">Dashboard →</Link>
        </div>
      </div>
    </main>
  );
}
