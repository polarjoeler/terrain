import Link from "next/link";
import { Wordmark } from "@/app/components/logo";
import { cachedAgg } from "@/lib/agg-cache";
import { africaTimeline, type AfricaTimeline } from "@/lib/africa-timeline";
import { AfricaReplay } from "@/app/insights/africa/africa-replay";

// PUBLIC, shareable full-map page — no login gate (unlike /insights/africa). Just the animated map.
export const metadata = {
  title: "African eCommerce, coming to life — Terrain",
  description: "Watch a decade of African online-store growth replay across the map in thirty seconds. Live market intelligence from Terrain.",
  openGraph: {
    title: "African eCommerce, coming to life",
    description: "A decade of African online-store growth, replayed across the map in thirty seconds.",
  },
};
export const revalidate = 900;

const EMPTY: AfricaTimeline = { months: [], countries: {}, pulses: [], featured: [], ops: { scanned24h: 0, disc7d: 0, discToday: 0, recent: [] }, meta: { lastLaunch: null, lastRefresh: null, totalTracked: 0, withoutDate: 0 } };

export default async function AfricaPublicMap() {
  const data = await cachedAgg("africa:timeline:v3", 30 * 60 * 1000, africaTimeline).catch(() => EMPTY);
  const ready = data.months.length > 0;

  return (
    <main className="min-h-screen px-4 py-6 md:px-8">
      <div className="mx-auto max-w-6xl">
        <nav className="flex items-center justify-between">
          <Link href="/" className="text-cream"><Wordmark /></Link>
          <Link href="/#join" className="rounded-full bg-cyan px-4 py-2 text-sm font-medium text-cyan-deep transition hover:brightness-110">Join the list</Link>
        </nav>

        <header className="mt-8">
          <span className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan">Market intelligence for African commerce</span>
          <h1 className="mt-3 max-w-3xl font-display text-4xl leading-[1.02] tracking-tight md:text-6xl">
            African eCommerce, <em className="text-cyan">coming to life.</em>
          </h1>
          <p className="mt-4 max-w-2xl text-cream/60">
            {data.meta.totalTracked.toLocaleString()} stores tracked across the continent, each pulse a real merchant appearing by its estimated launch date. Watch a decade of growth in thirty seconds — or scrub the timeline yourself.
          </p>
        </header>

        <div className="mt-6">
          {ready ? <AfricaReplay data={data} /> : <p className="rounded-[2rem] border border-cream/12 bg-cream/[0.02] p-8 text-sm text-cream/40">Map warming up…</p>}
        </div>

        <footer className="mt-12 border-t border-cream/12 pt-6 text-sm text-cream/45">
          <span>A <Link href="/" className="text-cream/70 hover:text-cream">Terrain</Link> preview · part of the Tembo Commerce family</span>
        </footer>
      </div>
    </main>
  );
}
