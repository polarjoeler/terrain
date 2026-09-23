import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser, isAdmin } from "@/lib/auth";
import { getSubscriber, hasAccess } from "@/lib/subscriptions";
import { cachedAgg } from "@/lib/agg-cache";
import { africaTimeline, type AfricaTimeline } from "@/lib/africa-timeline";
import { AfricaReplay } from "./africa-replay";

export const metadata = { title: "Terrain — African eCommerce" };
export const dynamic = "force-dynamic";

const EMPTY: AfricaTimeline = { months: [], countries: {}, pulses: [], featured: [], ops: { scanned24h: 0, disc7d: 0, discToday: 0, recent: [] }, meta: { lastLaunch: null, lastRefresh: null, totalTracked: 0, withoutDate: 0 } };

export default async function AfricaOverview() {
  const email = await currentUser();
  if (!email) redirect("/login");
  const subscriber = await getSubscriber(email).catch(() => null);
  if (!hasAccess(subscriber) && !isAdmin(email)) redirect("/billing");

  const data = await cachedAgg("africa:timeline:v3", 30 * 60 * 1000, africaTimeline).catch(() => EMPTY);
  const ready = data.months.length > 0;

  return (
    <main className="min-h-screen px-4 py-6 md:px-8">
      <div className="mx-auto max-w-6xl">
        <nav className="flex items-center justify-between">
          <Link href="/insights" className="text-sm text-cream/60 hover:text-cream">← Insights</Link>
          <span className="rounded-full border border-cream/15 px-3 py-1 text-xs font-medium uppercase tracking-wide text-cream/50">
            Updated {data.meta.lastRefresh ?? "recently"}
          </span>
        </nav>

        <header className="mt-8">
          <h1 className="font-display text-4xl md:text-5xl">African eCommerce, coming to life</h1>
          <p className="mt-2 max-w-2xl text-cream/60">
            {data.meta.totalTracked.toLocaleString()} stores tracked across the continent, each pulse a real merchant appearing by its estimated launch date. Watch a decade of growth replay in half a minute — or scrub the timeline yourself.
          </p>
        </header>

        <div className="mt-6">
          {ready
            ? <AfricaReplay data={data} />
            : <p className="rounded-[2rem] border border-cream/12 bg-cream/[0.02] p-8 text-sm text-cream/40">No coverage yet.</p>}
        </div>
      </div>
    </main>
  );
}
