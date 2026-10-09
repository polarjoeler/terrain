import Link from "next/link";
import { headers } from "next/headers";
import { Wordmark } from "@/app/components/logo";
import { cachedAgg } from "@/lib/agg-cache";
import { africaTimeline, type AfricaTimeline } from "@/lib/africa-timeline";
import SNAPSHOT from "@/lib/africa-timeline-snapshot.json";
import WORLD_POINTS from "@/lib/world-points-snapshot.json";
import { AfricaReplay } from "@/app/(app)/insights/africa/africa-replay";
import { WorldHero, type WorldRegion } from "@/app/components/world-hero";
import { Capabilities, TechStrip } from "@/app/components/home-sections";
import { NewsletterCTA } from "@/app/components/newsletter-cta";

export const metadata = { title: "Terrain — African eCommerce, coming to life" };
// force-dynamic (not ISR): ISR prerenders at BUILD, which runs africaTimeline's DB aggregate during
// every deploy and spikes the burstable instance → the "it breaks after each deploy" cycle. Dynamic
// keeps this off the build path; at request time cachedAgg serves the warm/stale row fast.
export const dynamic = "force-dynamic";

// Committed real snapshot (refreshed by the refresh-browse cron). The map NEVER renders blank — even on
// a cold cache or a DB outage, we fall back to this instead of an empty state. See scripts/snapshot-africa.
const SNAP = SNAPSHOT as unknown as AfricaTimeline;

const SEGMENTS = [
  ["🔬", "Researchers", "Clean, structured market data to cite and build on."],
  ["🧭", "Freelancers & Consultants", "Win pitches with the whole landscape in one view."],
  ["🏢", "Agencies", "Find prospects and prove the market to clients."],
  ["📈", "Investors", "Size markets and spot momentum before it's obvious."],
  ["💳", "Payment Providers", "See who's live, on what rails, and who to win."],
  ["🧩", "App Builders", "Reach the right merchants with the right integrations."],
  ["📦", "Shipping Providers", "Map demand and route into growing store clusters."],
  ["🛍️", "Online Stores", "Benchmark against the market and find your edge."],
];

// Platforms Terrain reads the stack across — shown in the credibility band. Styled wordmarks (not the
// trademarked logo artwork); drop official SVGs into /public/logos and swap when ready.
const PLATFORMS = ["Shopify", "WooCommerce", "Wix", "Adobe Commerce", "Squarespace", "Ecwid", "BigCommerce", "PrestaShop"];

function Nav() {
  return (
    <nav className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 rounded-full border border-cream/12 bg-cream/[0.06] py-2 pl-5 pr-2 backdrop-blur">
      <Link href="/" className="text-cream"><Wordmark /></Link>
      <div className="hidden gap-7 text-sm text-cream/60 md:flex">
        <a href="#map" className="hover:text-cream">The map</a>
        <a href="#capabilities" className="hover:text-cream">What we do</a>
        <a href="#who" className="hover:text-cream">Who it&apos;s for</a>
        <Link href="/japan" className="hover:text-cream">日本</Link>
      </div>
      <a href="#join" className="shrink-0 whitespace-nowrap rounded-full bg-cyan px-5 py-2.5 text-sm font-medium text-cyan-deep transition hover:brightness-110">Join the list</a>
    </nav>
  );
}

export default async function Home() {
  // force-dynamic renders per-request, so NEVER block on a cold aggregate: serve the warm cache if ready
  // within 4s, otherwise fall back to the committed snapshot (real data, never blank). The cron keeps the
  // live row warm; this race only guards the rare cold-key moment so the page is always instant.
  const agg = cachedAgg("africa:timeline:v3", 30 * 60 * 1000, africaTimeline).catch(() => SNAP);
  const data = await Promise.race([agg, new Promise<AfricaTimeline>((r) => setTimeout(() => r(SNAP), 4000))]);
  const ready = data.months.length > 0;

  // Zoom the global flight to the visitor's region (Vercel edge geo). Japan gets 日本; everyone else
  // lands on Africa — the home market. No DB work: the world outline + store weights are committed.
  const country = (await headers()).get("x-vercel-ip-country")?.toUpperCase() ?? "";
  const region: WorldRegion = country === "JP" ? "japan" : "africa";

  return (
    <main className="pt-4">
      <div className="px-4"><Nav /></div>

      {/* hero — the thesis + the catchy hook. The map shows what we're excited about; it isn't the pitch. */}
      <header className="mx-auto max-w-6xl px-6 pb-2 pt-16 md:pt-20">
        <span className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan">Market intelligence for African commerce</span>
        <h1 className="mt-4 max-w-3xl font-display text-5xl leading-[1.02] tracking-tight md:text-7xl">
          Every online store, <em className="text-cyan">read in full.</em>
        </h1>
        <p className="mt-5 max-w-2xl text-lg text-cream/60">
          Terrain tracks every eCommerce store across Africa — what it sells, what it&apos;s built with, who it pays, and how it moves — and turns the whole market into intelligence you can act on.
        </p>
        <div className="mt-7 flex flex-wrap items-center gap-3">
          <a href="#join" className="rounded-full bg-cyan px-6 py-3 text-sm font-medium text-cyan-deep transition hover:brightness-110">Get early access</a>
          <a href="#map" className="rounded-full border border-cream/20 px-6 py-3 text-sm text-cream/75 transition hover:text-cream">See it in full</a>
        </div>
      </header>

      {/* the global flight — the catchy hook: stores pop up worldwide, then zoom into your region */}
      <section className="mx-auto max-w-5xl px-4 pb-4 pt-8">
        <WorldHero region={region} points={WORLD_POINTS as { iso2: string; n: number }[]} />
      </section>

      {/* the detailed, real, interactive replay — the depth behind the spectacle */}
      <section id="map" className="px-4 py-14">
        <div className="mx-auto max-w-5xl">
          <div className="mb-5 flex flex-wrap items-end justify-between gap-2">
            <div>
              <span className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan">Live from the field</span>
              <h2 className="mt-2 font-display text-3xl font-bold tracking-tight md:text-4xl">Africa, store by store.</h2>
            </div>
            <p className="max-w-xs text-sm text-cream/50">Every store appears on the day it launched — a decade of African eCommerce, replayed from real data.</p>
          </div>
          {ready ? <AfricaReplay data={data} /> : <p className="rounded-[2rem] border border-cream/12 bg-cream/[0.02] p-8 text-sm text-cream/40">Map warming up…</p>}
        </div>
      </section>

      {/* what we read — the CMS credibility band (not a logo wall) */}
      <TechStrip platforms={PLATFORMS} />

      {/* what Terrain does — the product, as a calm four-band rhythm */}
      <Capabilities />

      {/* who it's for */}
      <section id="who" className="px-4 py-8 pb-20">
        <div className="mx-auto max-w-6xl">
          <span className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan">Who it&apos;s for</span>
          <h2 className="mt-3 font-display text-4xl tracking-tight md:text-5xl">Built for the people who move the market.</h2>
          <div className="mt-10 grid grid-cols-2 gap-3 md:grid-cols-4">
            {SEGMENTS.map((s) => (
              <div key={s[1]} className="rounded-2xl border border-cream/12 bg-cream/[0.02] p-5">
                <span className="text-xl">{s[0]}</span>
                <div className="mt-2 font-semibold text-cream">{s[1]}</div>
                <div className="mt-1 text-[12.5px] text-cream/55">{s[2]}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <NewsletterCTA />

      <footer className="overflow-hidden px-6 pb-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 border-t border-cream/12 pt-8 text-sm text-cream/45 md:flex-row">
          <Link href="/" className="text-cream/80"><Wordmark size="text-base" /></Link>
          <span>Africa &amp; global · <Link href="/japan" className="text-cream/70 hover:text-cream">日本 (JP/EN)</Link> · a Tembo Commerce product</span>
          <a href="mailto:hello@tembocommerce.app" className="underline">hello@tembocommerce.app</a>
        </div>
      </footer>
    </main>
  );
}
