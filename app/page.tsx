import Link from "next/link";
import { Wordmark } from "@/app/components/logo";
import { cachedAgg } from "@/lib/agg-cache";
import { africaTimeline, type AfricaTimeline } from "@/lib/africa-timeline";
import { AfricaReplay } from "@/app/insights/africa/africa-replay";
import { NewsletterCTA } from "@/app/components/newsletter-cta";

export const metadata = { title: "Terrain — African eCommerce, coming to life" };
export const revalidate = 900;

const EMPTY: AfricaTimeline = { months: [], countries: {}, pulses: [], featured: [], ops: { scanned24h: 0, disc7d: 0, discToday: 0, recent: [] }, meta: { lastLaunch: null, lastRefresh: null, totalTracked: 0, withoutDate: 0 } };

// One spine, three lenses. Radar + Shelf sell to brands; Switchboard sells to vendors.
const PRODUCTS = [
  { key: "Radar", glyph: "◎", audience: "For brands", tone: "cyan",
    line: "Clone & brand-abuse detection. Radar fingerprints your catalogue — images, SKUs, prices — and finds every store copying it, then keeps watching for new ones.", href: "/radar" },
  { key: "Switchboard", glyph: "⇄", audience: "For payment, shipping & app vendors", tone: "mint",
    line: "Win/loss and share-of-market on the rails. See who's switching payment, shipping and app providers — where, when, and to whom — across the market.", href: "/insights/switches" },
  { key: "Shelf", glyph: "▤", audience: "For brands", tone: "lilac",
    line: "Distribution monitoring. Track where your product — and your competitors' — sits on the shelf across every storefront that carries it.", href: "/insights" },
];

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

function Nav() {
  return (
    <nav className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 rounded-full border border-cream/12 bg-cream/[0.06] py-2 pl-5 pr-2 backdrop-blur">
      <Link href="/" className="text-cream"><Wordmark /></Link>
      <div className="hidden gap-7 text-sm text-cream/60 md:flex">
        <a href="#map" className="hover:text-cream">The map</a>
        <a href="#products" className="hover:text-cream">Products</a>
        <a href="#who" className="hover:text-cream">Who it&apos;s for</a>
        <Link href="/insights/japan" className="hover:text-cream">日本</Link>
      </div>
      <a href="#join" className="shrink-0 whitespace-nowrap rounded-full bg-cyan px-5 py-2.5 text-sm font-medium text-cyan-deep transition hover:brightness-110">Join the list</a>
    </nav>
  );
}

const toneCls: Record<string, string> = {
  cyan: "border-cyan/25 text-cyan", mint: "border-mint/25 text-mint", lilac: "border-lilac/25 text-lilac",
};
const toneBg: Record<string, string> = { cyan: "rgba(76,201,212,.14)", mint: "rgba(205,234,169,.16)", lilac: "rgba(202,189,245,.18)" };
const toneFg: Record<string, string> = { cyan: "var(--color-cyan)", mint: "var(--color-mint)", lilac: "var(--color-lilac)" };

export default async function Home() {
  const data = await cachedAgg("africa:timeline:v3", 30 * 60 * 1000, africaTimeline).catch(() => EMPTY);
  const ready = data.months.length > 0;

  return (
    <main className="pt-4">
      <div className="px-4"><Nav /></div>

      {/* hero copy */}
      <header className="mx-auto max-w-6xl px-6 pb-2 pt-14">
        <span className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan">Market intelligence for African commerce</span>
        <h1 className="mt-4 max-w-3xl font-display text-5xl leading-[1.02] tracking-tight md:text-7xl">
          See African eCommerce <em className="text-cyan">come to life.</em>
        </h1>
        <p className="mt-5 max-w-2xl text-lg text-cream/60">
          Every online store on the continent, appearing on the map by its launch date — a decade of growth in thirty seconds. Terrain tracks it so you don&apos;t have to.
        </p>
      </header>

      {/* the live map — the full interface */}
      <section id="map" className="px-4 py-8">
        <div className="mx-auto max-w-6xl">
          {ready ? <AfricaReplay data={data} /> : <p className="rounded-[2rem] border border-cream/12 bg-cream/[0.02] p-8 text-sm text-cream/40">Map warming up…</p>}
        </div>
      </section>

      {/* products */}
      <section id="products" className="px-4 py-20">
        <div className="mx-auto max-w-6xl">
          <span className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan">One spine, three lenses</span>
          <h2 className="mt-3 max-w-2xl font-display text-4xl tracking-tight md:text-5xl">The same market, seen the way you need it.</h2>
          <p className="mt-3 max-w-xl text-cream/55">Every store, what it sells, what it&apos;s built with, who it pays — read as brand protection, distribution, or the fight for the rails.</p>
          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {PRODUCTS.map((p) => (
              <Link key={p.key} href={p.href} className={`group rounded-[1.75rem] border ${toneCls[p.tone]} bg-cream/[0.02] p-7 transition hover:bg-cream/[0.04]`}>
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl font-display text-2xl" style={{ background: toneBg[p.tone], color: toneFg[p.tone] }}>{p.glyph}</div>
                <div className="mt-5 flex items-baseline justify-between gap-2">
                  <h3 className="font-display text-3xl text-cream">{p.key}</h3>
                  <span className="text-[11px] uppercase tracking-wide text-cream/40">{p.audience}</span>
                </div>
                <p className="mt-3 text-sm leading-relaxed text-cream/60">{p.line}</p>
                <span className="mt-4 inline-block text-sm text-cream/50 transition group-hover:text-cream">Explore {p.key} →</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

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
          <span>Africa &amp; global · <Link href="/insights/japan" className="text-cream/70 hover:text-cream">日本 (JP/EN)</Link> · a Tembo Commerce product</span>
          <a href="mailto:hello@tembocommerce.com" className="underline">hello@tembocommerce.com</a>
        </div>
      </footer>
    </main>
  );
}
