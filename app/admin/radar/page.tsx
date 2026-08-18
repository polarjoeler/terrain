import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser, isAdmin } from "@/lib/auth";
import { listAudits, listDetections, listMonitorDetections, type Detection } from "@/lib/radar/audit";
import { monitoredBrandCount } from "@/lib/radar/brands";
import { coverage } from "@/lib/radar/fingerprints";
import type { Verdict } from "@/lib/radar/catalog";

export const metadata = { title: "Radar — Detections" };
export const dynamic = "force-dynamic";

const VERDICT: Record<Verdict, string> = {
  COPY: "bg-cyan text-cyan-deep",
  LIKELY: "bg-cyan/70 text-cyan-deep",
  PARTIAL: "bg-cream/15 text-cream",
  clean: "bg-cream/10 text-cream/50",
};

function ago(iso: string): string {
  const d = (Date.now() - new Date(iso).getTime()) / 864e5;
  if (d < 1) return "today";
  if (d < 2) return "yesterday";
  if (d < 30) return `${Math.floor(d)}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function Tile({ n, label, accent }: { n: number | string; label: string; accent?: boolean }) {
  return (
    <div className={`rounded-3xl border p-5 ${accent ? "border-cyan/30 bg-cyan/[0.06]" : "border-cream/12"}`}>
      <div className={`font-display text-4xl ${accent ? "text-cyan" : "text-cream"}`}>{n}</div>
      <div className="mt-1 text-xs font-semibold uppercase tracking-wide text-cream/45">{label}</div>
    </div>
  );
}

function DetectionCard({ d }: { d: Detection }) {
  return (
    <div className="rounded-2xl border border-cream/12 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-cream">{d.suspect}</div>
          <div className="truncate text-xs text-cream/45">
            copying <span className="text-cream/70">{d.brandName || d.brandDomain}</span>
            {" · "}
            {ago(d.at)}
          </div>
        </div>
        <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-bold ${VERDICT[d.verdict]}`}>
          {d.verdict} · {d.score}
        </span>
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-cream/55">
        {d.reasons.slice(0, 3).map((r, i) => (
          <li key={i}>› {r}</li>
        ))}
      </ul>
      <div className="mt-3 flex items-center gap-3 text-xs">
        {d.source === "monitor" ? (
          <span className="inline-flex items-center gap-1.5 text-cream/45">
            <span className="h-1.5 w-1.5 rounded-full bg-cyan" /> Live monitor
          </span>
        ) : (
          <Link href={`/radar/scan/${d.auditId}`} className="text-cyan hover:underline">
            View audit →
          </Link>
        )}
      </div>
    </div>
  );
}

export default async function RadarDashboard() {
  const email = await currentUser();
  if (!email) redirect("/login");
  if (!isAdmin(email)) redirect("/dashboard");

  const [audits, auditDetections, monitorDetections, monitored, cov] = await Promise.all([
    listAudits(100).catch(() => []),
    listDetections(25).catch(() => []),
    listMonitorDetections(25).catch(() => []),
    monitoredBrandCount().catch(() => 0),
    coverage("South Africa").catch(() => ({
      universe: 0,
      fingerprinted: 0,
      remaining: 0,
      withCatalogue: 0,
    })),
  ]);

  // Merge audit + monitoring detections, deduped per (brand, suspect), keeping
  // the higher-scoring sighting (a live-monitor hit usually supersedes an audit).
  const byPair = new Map<string, Detection>();
  for (const d of [...auditDetections, ...monitorDetections]) {
    const key = `${d.brandDomain}→${d.suspect}`;
    const prev = byPair.get(key);
    if (!prev || d.score > prev.score) byPair.set(key, d);
  }
  const detections = [...byPair.values()].sort((a, b) => b.score - a.score);

  const confirmed = detections.filter((d) => d.verdict === "COPY" || d.verdict === "LIKELY");
  const partials = detections.filter((d) => d.verdict === "PARTIAL");

  return (
    <div className="min-h-screen bg-[#0b0e10] px-4 py-6 md:px-8">
      <div className="mx-auto max-w-5xl">
        <nav className="flex items-center justify-between">
          <Link href="/radar" className="flex items-center gap-2 text-cream">
            <span className="text-xl font-semibold tracking-tight">◎ Radar</span>
          </Link>
          <div className="flex items-center gap-3 text-sm">
            <Link href="/admin" className="text-cream/50 hover:text-cream">
              Import
            </Link>
            <span className="rounded-full border border-cyan/30 bg-cyan/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-cyan">
              Detections
            </span>
          </div>
        </nav>

        <header className="mt-10">
          <h1 className="font-display text-4xl md:text-5xl">Radar detections</h1>
          <p className="mt-2 text-cream/60">
            Every clone found across all brand audits, and the store universe
            they&apos;re matched against.
          </p>
        </header>

        <div className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Tile n={confirmed.length} label="Confirmed clones" accent />
          <Tile n={monitored} label="Monitored brands" />
          <Tile n={audits.length} label="Audits run" />
          <Tile n={cov.withCatalogue.toLocaleString()} label="Stores fingerprinted" />
        </div>

        {/* detections */}
        <section className="mt-12">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-cream/50">
            Confirmed & likely clones
          </h2>
          {confirmed.length === 0 ? (
            <p className="mt-4 rounded-2xl border border-cream/12 p-6 text-sm text-cream/50">
              No confirmed clones yet. Run a brand audit from{" "}
              <Link href="/radar/scan" className="text-cyan hover:underline">
                /radar/scan
              </Link>
              .
            </p>
          ) : (
            <div className="mt-4 space-y-3">
              {confirmed.map((d) => (
                <DetectionCard key={`${d.brandDomain}-${d.suspect}`} d={d} />
              ))}
            </div>
          )}

          {partials.length > 0 && (
            <>
              <h2 className="mt-10 text-sm font-semibold uppercase tracking-wide text-cream/50">
                Partial matches ({partials.length})
              </h2>
              <div className="mt-4 space-y-3">
                {partials.map((d) => (
                  <DetectionCard key={`${d.brandDomain}-${d.suspect}`} d={d} />
                ))}
              </div>
            </>
          )}
        </section>

        {/* audit log */}
        <section className="mt-12">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-cream/50">
            Recent audits
          </h2>
          <div className="mt-4 overflow-hidden rounded-2xl border border-cream/12">
            {audits.length === 0 ? (
              <p className="p-6 text-sm text-cream/50">No audits run yet.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {audits.map((a) => (
                    <tr key={a.id} className="border-b border-cream/8 last:border-0">
                      <td className="px-4 py-3">
                        <Link href={`/radar/scan/${a.id}`} className="text-cream hover:text-cyan">
                          {a.brandName || a.brandDomain}
                        </Link>
                        <div className="text-xs text-cream/40">{a.brandDomain}</div>
                      </td>
                      <td className="px-4 py-3 text-cream/50">{a.market}</td>
                      <td className="px-4 py-3 text-right">
                        {a.copies > 0 ? (
                          <span className="rounded-full bg-cyan/15 px-2.5 py-1 text-xs font-semibold text-cyan">
                            {a.copies} clone{a.copies === 1 ? "" : "s"}
                          </span>
                        ) : (
                          <span className="text-xs text-cream/35">clean</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right text-xs text-cream/40">{ago(a.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
