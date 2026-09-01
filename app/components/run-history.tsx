import type { RadarRun } from "@/lib/radar/fraud-sweep";

/** Batch log — the last N sweeps with their date/time and what each surfaced, so
 *  it's obvious at a glance which runs are recent and which found new clones. */
export function RunHistory({ runs }: { runs: RadarRun[] }) {
  if (!runs || runs.length === 0) return null;

  const when = (iso: string) => {
    const d = new Date(iso);
    const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    return { date, time };
  };
  const num = (s: Record<string, number>, k: string) => (typeof s[k] === "number" ? s[k] : 0);

  return (
    <div className="mt-4 overflow-x-auto rounded-2xl border border-cream/12 bg-cream/[0.02]">
      <div className="border-b border-cream/10 px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-cream/40">
        Sweep history
      </div>
      <table className="w-full min-w-[34rem] text-sm">
        <tbody>
          {runs.map((r, idx) => {
            const { date, time } = when(r.ranAt);
            const isLatest = idx === 0;
            const newN = num(r.summary, "newDetections");
            return (
              <tr
                key={r.ranAt}
                className={`border-b border-cream/[0.06] last:border-0 ${isLatest ? "bg-cream/[0.03]" : ""}`}
              >
                <td className="whitespace-nowrap px-5 py-2.5">
                  <span className="text-cream/80">{date}</span>
                  <span className="ml-2 font-mono text-xs text-cream/45">{time}</span>
                  {isLatest && (
                    <span className="ml-2 rounded-full bg-cyan/15 px-2 py-0.5 text-[9px] font-bold uppercase text-cyan">Latest</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 text-right text-cream/55">
                  {num(r.summary, "clusters").toLocaleString()} clusters
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 text-right text-cream/55">
                  {num(r.summary, "written").toLocaleString()} detections
                </td>
                <td className="whitespace-nowrap px-5 py-2.5 text-right">
                  {newN > 0 ? (
                    <span className="font-semibold text-orange">+{newN.toLocaleString()} new</span>
                  ) : (
                    <span className="text-cream/25">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
