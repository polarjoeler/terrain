import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser, isAdmin } from "@/lib/auth";
import { fraudClusters } from "@/lib/radar/fraud";
import { lastRun, recentRuns, previousRunAt } from "@/lib/radar/fraud-sweep";
import { FraudClusterCard } from "./cluster";
import { RunSweep } from "./run-sweep";
import { RunHistory } from "@/app/components/run-history";

export const dynamic = "force-dynamic";
export const metadata = { title: "Radar — Market fraud" };

export default async function MarketFraud() {
  const email = await currentUser();
  if (!email) redirect("/login");
  if (!isAdmin(email)) redirect("/dashboard");

  // Run these sequentially-ish via one Promise.all but keep it small: the previous-run
  // boundary drives "new this sweep", and the history strip shows the batch cadence.
  const [run, prevAt, history] = await Promise.all([
    lastRun("fraud").catch(() => null),
    previousRunAt("fraud").catch(() => null),
    recentRuns("fraud", 8).catch(() => []),
  ]);
  const clusters = await fraudClusters(25, prevAt).catch(() => []);
  const totalClones = clusters.reduce((n, c) => n + c.clones.length, 0);
  const withEmail = clusters.filter((c) => c.victimEmail && !c.enrolled).length;
  const newThisSweep = clusters.reduce((n, c) => n + c.newCount, 0);

  return (
    <main className="min-h-screen px-4 py-6 md:px-8">
      <div className="mx-auto max-w-4xl">
        <nav className="flex items-center justify-between">
          <Link href="/admin/radar" className="text-sm text-cream/60 hover:text-cream">← Radar detections</Link>
          <span className="rounded-full border border-orange/30 bg-orange/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-orange">
            Admin
          </span>
        </nav>

        <header className="mt-8">
          <h1 className="font-display text-4xl md:text-5xl text-cream">Market fraud</h1>
          <p className="mt-2 text-cream/60">
            {clusters.length.toLocaleString()} victim brand{clusters.length === 1 ? "" : "s"} ·
            {" "}{totalClones.toLocaleString()} suspected clone{totalClones === 1 ? "" : "s"} ·
            {" "}<span className="text-cyan">{withEmail.toLocaleString()} contactable, not-yet-customers</span> —
            each one is a warm lead. Catalogue collisions found across every store we fingerprint,
            no enrolment needed.
          </p>
          <RunSweep lastRun={run} />
          <RunHistory runs={history} />
        </header>

        {clusters.length === 0 ? (
          <div className="mt-10 rounded-[2rem] border border-cream/12 p-8 text-center text-cream/55">
            No fraud clusters detected yet — the sweep runs each pipeline cycle.
          </div>
        ) : (
          (() => {
            const fresh = clusters.filter((c) => c.newCount > 0);
            const earlier = clusters.filter((c) => c.newCount === 0);
            const Heading = ({ children }: { children: React.ReactNode }) => (
              <h2 className="mb-3 mt-8 text-[11px] font-semibold uppercase tracking-wider text-cream/40">{children}</h2>
            );
            return (
              <div className="mt-4">
                {fresh.length > 0 && (
                  <>
                    <Heading>
                      <span className="text-orange">🆕 New this sweep</span> · {newThisSweep} detection{newThisSweep === 1 ? "" : "s"} across {fresh.length} brand{fresh.length === 1 ? "" : "s"}
                      {run && <span className="text-cream/30"> · since the previous run</span>}
                    </Heading>
                    <div className="space-y-5">
                      {fresh.map((c) => <FraudClusterCard key={c.victim} cluster={c} />)}
                    </div>
                  </>
                )}
                {earlier.length > 0 && (
                  <>
                    <Heading>{fresh.length > 0 ? "Seen before" : "All detections"}</Heading>
                    <div className="space-y-5">
                      {earlier.map((c) => <FraudClusterCard key={c.victim} cluster={c} />)}
                    </div>
                  </>
                )}
              </div>
            );
          })()
        )}
      </div>
    </main>
  );
}
