import { fetchInsights } from "@/lib/sheets";
import { importedLiveness } from "@/lib/imported";
import { InsightsView } from "./insights-view";

export const metadata = { title: "Terrain — Market Insights" };
// Reads the latest snapshot per request (the Sheet fetch is uncached).
export const dynamic = "force-dynamic";

function ChurnStrip({
  live,
}: {
  live: Awaited<ReturnType<typeof importedLiveness>>;
}) {
  if (!live.checked) return null;
  const cards = [
    { n: `${live.survival}%`, label: "still live", tone: "mint" },
    { n: live.active.toLocaleString(), label: "active", tone: "outline" },
    { n: live.migrated.toLocaleString(), label: "migrated off Shopify", tone: "outline" },
    { n: live.dead.toLocaleString(), label: "closed", tone: "outline" },
  ];
  return (
    <section className="mx-auto max-w-5xl px-6 pt-10">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-cream/45">
          SA Shopify survival
        </h2>
        <span className="text-xs text-cream/35">
          verified {live.checked.toLocaleString()} of {live.total.toLocaleString()} stores
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {cards.map((c) => (
          <div
            key={c.label}
            className={`rounded-3xl px-5 py-6 ${
              c.tone === "mint" ? "bg-mint text-ink" : "border border-cream/12 text-cream"
            }`}
          >
            <div className="font-display text-4xl leading-none tracking-tight md:text-5xl">
              {c.n}
            </div>
            <div
              className={`mt-2 text-xs font-medium uppercase tracking-wide ${
                c.tone === "mint" ? "opacity-70" : "text-cream/45"
              }`}
            >
              {c.label}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export default async function Insights() {
  const [{ latest, history }, live] = await Promise.all([
    fetchInsights(),
    importedLiveness().catch(() => ({
      total: 0, checked: 0, active: 0, migrated: 0, dead: 0, survival: null,
    })),
  ]);
  return (
    <>
      <ChurnStrip live={live} />
      <InsightsView snapshot={latest} history={history} live={latest !== null} />
    </>
  );
}
