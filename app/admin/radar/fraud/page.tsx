import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser, isAdmin } from "@/lib/auth";
import { fraudClusters } from "@/lib/radar/fraud";
import { Outreach } from "./outreach";

export const dynamic = "force-dynamic";
export const metadata = { title: "Radar — Market fraud" };

const usd = (n: number | null) =>
  n == null ? null : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M/mo` : n >= 1e3 ? `$${Math.round(n / 1e3)}k/mo` : `$${Math.round(n)}/mo`;

function ago(iso: string) {
  const d = (Date.now() - new Date(iso).getTime()) / 864e5;
  if (d < 1) return "today";
  if (d < 2) return "yesterday";
  if (d < 30) return `${Math.floor(d)}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export default async function MarketFraud() {
  const email = await currentUser();
  if (!email) redirect("/login");
  if (!isAdmin(email)) redirect("/dashboard");

  const clusters = await fraudClusters().catch(() => []);
  const totalClones = clusters.reduce((n, c) => n + c.clones.length, 0);
  const withEmail = clusters.filter((c) => c.victimEmail && !c.enrolled).length;

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
        </header>

        {clusters.length === 0 ? (
          <div className="mt-10 rounded-[2rem] border border-cream/12 p-8 text-center text-cream/55">
            No fraud clusters detected yet — the sweep runs each pipeline cycle.
          </div>
        ) : (
          <div className="mt-8 space-y-5">
            {clusters.map((c) => (
              <section key={c.victim} className="rounded-[2rem] border border-cream/12 bg-cream/[0.02] p-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-display text-xl text-cream">{c.victimName || c.victim}</h2>
                      {c.enrolled ? (
                        <span className="rounded-full bg-mint/20 px-2.5 py-0.5 text-[10px] font-bold uppercase text-mint">Customer</span>
                      ) : (
                        <span className="rounded-full bg-cyan/15 px-2.5 py-0.5 text-[10px] font-bold uppercase text-cyan">Lead</span>
                      )}
                    </div>
                    <a href={`https://${c.victim}`} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-cream/45 hover:underline">
                      {c.victim}
                    </a>
                    {usd(c.estSales) && <span className="ml-2 text-xs text-cream/40">· {usd(c.estSales)}</span>}
                  </div>
                  <span className="shrink-0 rounded-full bg-orange/15 px-3 py-1 text-xs font-bold text-orange">
                    {c.clones.length} clone{c.clones.length === 1 ? "" : "s"}
                  </span>
                </div>

                <ul className="mt-4 space-y-2">
                  {c.clones.map((cl) => (
                    <li key={cl.suspect} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-cream/10 px-4 py-2.5">
                      <div className="min-w-0">
                        <a href={`https://${cl.suspect}`} target="_blank" rel="noopener noreferrer" className="font-mono text-sm text-cream hover:underline">
                          {cl.suspect}
                        </a>
                        <div className="text-[11px] text-cream/40">{cl.reasons[0] ?? "catalogue match"} · first seen {ago(cl.at)}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="rounded-full bg-cyan/15 px-2.5 py-0.5 text-[11px] font-bold text-cyan">{cl.verdict} · {cl.score}</span>
                        <Link
                          href={`/radar/dossier/${encodeURIComponent(c.victim)}/${encodeURIComponent(cl.suspect)}`}
                          className="text-[11px] font-medium text-cyan hover:underline"
                        >
                          Dossier →
                        </Link>
                      </div>
                    </li>
                  ))}
                </ul>

                {!c.enrolled && (
                  <Outreach
                    victim={c.victim}
                    victimName={c.victimName}
                    victimEmail={c.victimEmail}
                    clones={c.clones.map((x) => x.suspect)}
                  />
                )}
              </section>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
