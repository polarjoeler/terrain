import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser, isAdmin } from "@/lib/auth";
import { getSubscriber, hasAccess } from "@/lib/subscriptions";
import { cachedAgg } from "@/lib/agg-cache";
import { japanTimeline, type JapanTimeline, JP_REGIONS } from "@/lib/japan-timeline";
import { JapanReplay } from "./japan-replay";

export const metadata = { title: "Terrain — Japanese eCommerce" };
export const dynamic = "force-dynamic";

const EMPTY: JapanTimeline = {
  months: [], regions: Object.fromEntries(JP_REGIONS.map((r) => [r, { shopify: [] as number[], woo: [] as number[], rest: [] as number[] }])) as unknown as JapanTimeline["regions"],
  pulses: [], featured: [], ops: { scanned24h: 0, disc7d: 0, discToday: 0, recent: [] },
  meta: { lastLaunch: null, lastRefresh: null, totalTracked: 0, located: 0 },
};

export default async function JapanOverview() {
  const email = await currentUser();
  if (!email) redirect("/login");
  const subscriber = await getSubscriber(email).catch(() => null);
  if (!hasAccess(subscriber) && !isAdmin(email)) redirect("/billing");

  const data = await cachedAgg("japan:timeline:v1", 30 * 60 * 1000, japanTimeline).catch(() => EMPTY);
  const ready = data.months.length > 0;

  return (
    <main className="min-h-screen px-4 py-6 md:px-8">
      <div className="mx-auto max-w-6xl">
        <nav className="flex items-center justify-between">
          <Link href="/insights" className="text-sm text-cream/60 hover:text-cream">← Insights</Link>
          <span className="rounded-full border border-cream/15 px-3 py-1 text-xs font-medium uppercase tracking-wide text-cream/50">Updated {data.meta.lastRefresh ?? "recently"}</span>
        </nav>

        <header className="mt-8">
          <h1 className="font-display text-4xl md:text-5xl">Japanese eCommerce, by region</h1>
          <p className="mt-2 max-w-2xl text-cream/60">
            {data.meta.totalTracked.toLocaleString()} stores tracked across Japan&apos;s eight regions, each pulse a real merchant appearing by its estimated launch date. Watch the growth replay — or scrub the timeline. Regional split is estimated (see the note under the chart).
          </p>
        </header>

        <div className="mt-6">
          {ready ? <JapanReplay data={data} /> : <p className="rounded-[2rem] border border-cream/12 bg-cream/[0.02] p-8 text-sm text-cream/40">No coverage yet.</p>}
        </div>
      </div>
    </main>
  );
}
