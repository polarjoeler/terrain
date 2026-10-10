import Link from "next/link";
import { headers } from "next/headers";
import { Wordmark } from "@/app/components/logo";
import WORLD_POINTS from "@/lib/world-points-snapshot.json";
import WORLD_STORES from "@/lib/world-stores-snapshot.json";
import GEO_TIMELINE from "@/lib/geo-timeline-snapshot.json";
import { LiveMap } from "@/app/components/live-map";
import { WhatWeDo, Capabilities, TechStrip, PlatformPreview, DigestByRole } from "@/app/components/home-sections";
import { NewsletterCTA } from "@/app/components/newsletter-cta";

export const metadata = { title: "Terrain — African eCommerce, coming to life" };
// force-dynamic: the page reads the visitor's region from request headers (x-vercel-ip-country) to aim
// the map's fly-in. All map data (world outline, store samples, per-country/city time series) is
// committed snapshots, so there's zero per-request DB work.
export const dynamic = "force-dynamic";

function Nav({ showJapan }: { showJapan: boolean }) {
  return (
    <nav className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 rounded-full border border-cream/12 bg-cream/[0.06] py-2 pl-5 pr-2 backdrop-blur">
      <Link href="/" className="text-cream"><Wordmark /></Link>
      <div className="hidden gap-7 text-sm text-cream/60 md:flex">
        <a href="#map" className="hover:text-cream">The map</a>
        <a href="#platform" className="hover:text-cream">Platform</a>
        <a href="#digest" className="hover:text-cream">Digest</a>
        {showJapan && <Link href="/japan" className="hover:text-cream">日本</Link>}
      </div>
      <a href="#join" className="shrink-0 whitespace-nowrap rounded-full bg-cyan px-5 py-2.5 text-sm font-medium text-cyan-deep transition hover:brightness-110">Join the list</a>
    </nav>
  );
}

export default async function Home() {
  // Aim the map's fly-in at the visitor's region (Vercel edge geo); show the 日本 switcher only for
  // visitors from Japan. No DB work — every map input is a committed snapshot.
  const country = (await headers()).get("x-vercel-ip-country")?.toUpperCase() ?? "";
  const showJapan = country === "JP";

  return (
    <main className="pt-4">
      <div className="px-4"><Nav showJapan={showJapan} /></div>

      {/* hero — the thesis + the catchy hook. The map shows what we're excited about; it isn't the pitch. */}
      <header className="mx-auto max-w-6xl px-6 pb-2 pt-16 md:pt-20">
        <span className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan">Lead generation &amp; market intelligence for African commerce</span>
        <h1 className="mt-4 max-w-3xl font-display text-5xl leading-[1.02] tracking-tight md:text-7xl">
          Every online store, <em className="text-cyan">a lead in full.</em>
        </h1>
        <p className="mt-5 max-w-2xl text-lg text-cream/60">
          Terrain tracks every eCommerce store across Africa — what it sells, what it&apos;s built with, who it pays, and how it moves — and turns the whole market into qualified leads you can push straight into your workflow.
        </p>
        <div className="mt-7 flex flex-wrap items-center gap-3">
          <a href="#join" className="rounded-full bg-cyan px-6 py-3 text-sm font-medium text-cyan-deep transition hover:brightness-110">Get early access</a>
          <a href="#map" className="rounded-full border border-cream/20 px-6 py-3 text-sm text-cream/75 transition hover:text-cream">See it in full</a>
        </div>
      </header>

      {/* one interactive map: globe → your region → click a country, with a ticking leaderboard + chart */}
      <section id="map" className="px-4 py-10">
        <div className="mx-auto max-w-6xl">
          <div className="mb-5 flex flex-wrap items-end justify-between gap-2">
            <div>
              <span className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan">Live from the field</span>
              <h2 className="mt-2 font-display text-3xl font-bold tracking-tight md:text-4xl">Zoom into the market.</h2>
            </div>
            <p className="max-w-xs text-sm text-cream/50">The globe flies into your region — pick any region or country and watch it grow, store by store.</p>
          </div>
          <LiveMap stores={WORLD_STORES as { c: string; d: string; n: string; g: "shopify" | "woo" | "rest" }[]} points={WORLD_POINTS as { iso2: string; n: number }[]} tl={GEO_TIMELINE as never} country={country} />
        </div>
      </section>

      {/* what we read — the CMS credibility band, with official platform marks */}
      <TechStrip />

      {/* what Terrain does — umbrella intro framing everything below (dashboard, digest, signals) */}
      <WhatWeDo />

      {/* the platform — the Overview/lead dashboard + pushing leads into Sheets, CRM, Slack, WhatsApp */}
      <PlatformPreview />

      {/* the weekly digest — the paid payoff, tailored per role */}
      <DigestByRole />

      {/* every signal we read — the four capability bands */}
      <Capabilities />

      <NewsletterCTA />

      <footer className="overflow-hidden px-6 pb-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 border-t border-cream/12 pt-8 text-sm text-cream/45 md:flex-row">
          <Link href="/" className="text-cream/80"><Wordmark size="text-base" /></Link>
          <span>Africa &amp; global{showJapan && <> · <Link href="/japan" className="text-cream/70 hover:text-cream">日本 (JP/EN)</Link></>} · a Tembo Commerce product</span>
          <a href="mailto:hello@heyterrain.com" className="underline">hello@heyterrain.com</a>
        </div>
      </footer>
    </main>
  );
}
