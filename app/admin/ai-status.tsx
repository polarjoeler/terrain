import type { AiEnrichmentStatus } from "@/lib/imported";

/** Read-only view of AI category/description coverage. The sweep runs from the
 *  Mac cron (scripts/ai-enrich-cron.sh) — merchant-site fetches are unreliable
 *  from serverless, so the web app only reports; it doesn't trigger. */
export function AiStatusPanel({ status }: { status: AiEnrichmentStatus }) {
  const pct = status.live ? Math.round((status.categorised / status.live) * 100) : 0;
  const last = status.lastRun
    ? new Date(status.lastRun).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" })
    : "never";

  const tiles: [string, number][] = [
    ["Live stores", status.live],
    ["Categorised", status.categorised],
    ["Uncategorised", status.uncategorised],
    ["Low-info (parked)", status.lowInfo],
  ];

  return (
    <section className="mt-12 rounded-3xl border border-cream/12 p-6 md:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl">AI enrichment — categories &amp; descriptions</h2>
          <p className="mt-1 max-w-lg text-sm text-cream/55">
            Synthesised from each live site&apos;s catalogue and homepage. Runs
            automatically each morning from the enrichment cron — this is a
            read-only view of coverage.
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-cream/15 px-4 py-2 text-xs uppercase tracking-wide text-cream/50">
          Last run · {last}
        </span>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tiles.map(([label, n]) => (
          <div key={label} className="rounded-2xl border border-cream/12 p-4">
            <div className="font-display text-3xl text-cyan">{n.toLocaleString()}</div>
            <div className="mt-1 text-xs uppercase tracking-wide text-cream/45">{label}</div>
          </div>
        ))}
      </div>

      <div className="mt-5">
        <div className="h-2 overflow-hidden rounded-full bg-cream/10">
          <div className="h-full rounded-full bg-cyan transition-all" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-2 text-xs text-cream/45">
          {pct}% of live stores categorised
          {status.uncategorised > 0 && ` · ${status.uncategorised.toLocaleString()} awaiting the next sweep`}
        </div>
      </div>
    </section>
  );
}
