import Link from "next/link";
import { TerrainMark, Wordmark } from "@/app/components/logo";
import { sampleLeads, feedStats } from "@/lib/leads";
import { checkoutUrl, pricing } from "@/lib/payments";

function Nav() {
  return (
    <nav className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 rounded-full border border-cream/12 bg-cream/[0.06] py-2 pl-4 pr-2 backdrop-blur sm:pl-5">
      <Link href="/" className="min-w-0 shrink text-cream">
        <Wordmark tone="cream" />
      </Link>
      <div className="hidden gap-7 text-sm text-cream/60 md:flex">
        <a href="#how" className="hover:text-cream">How it works</a>
        <a href="#data" className="hover:text-cream">The data</a>
        <a href="#pricing" className="hover:text-cream">Pricing</a>
        <Link href="/dashboard" className="hover:text-cream">Dashboard</Link>
      </div>
      <a
        href="#pricing"
        className="shrink-0 whitespace-nowrap rounded-full bg-cream px-4 py-2.5 text-sm font-medium text-ink transition hover:bg-paper sm:px-5"
      >
        Get the feed
      </a>
    </nav>
  );
}

function Ticker({ angle, reverse = false }: { angle: number; reverse?: boolean }) {
  const items = [
    "pawcarnival.co.za — found 07:14",
    "metaldeco.co.za — found 11:38",
    "bagworldza.co.za — found 09:51",
    "factory72.co.za — found 16:02",
    "lightswitches.co.za — found 13:27 · PLUS",
    "ariellesaphire.co.za — found 10:45",
    "avorix.co.za — found 18:19",
    "cheegourmet.co.za — found 08:33",
  ];
  const line = items.join("   ✦   ") + "   ✦   ";
  return (
    <div
      className="pointer-events-none absolute left-[-10%] right-[-10%] overflow-hidden rounded-full border border-cream/12 bg-cream/[0.05] py-2.5 text-xs font-medium tracking-wide text-cream/70"
      style={{ transform: `rotate(${angle}deg)` }}
    >
      <div
        className="ticker-track"
        style={reverse ? { animationDirection: "reverse" } : undefined}
      >
        <span>{line}</span>
        <span>{line}</span>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <header className="relative mx-auto flex max-w-4xl flex-col items-center px-6 pb-44 pt-16 text-center">
      <span className="mb-8 rounded-full border border-mint/25 bg-mint/10 px-4 py-1.5 text-xs font-medium text-mint">
        ✦ Contact emails included
      </span>
      <h1 className="font-display text-6xl leading-[1.0] tracking-tight md:text-8xl">
        Every new store.
        <br />
        <em className="text-orange">Found first.</em>
      </h1>
      <p className="mt-8 max-w-xl text-lg text-cream/60">
        Terrain maps new South African Shopify stores the day they go live —
        enriched with contact emails, product counts and pricing — delivered to
        your inbox every week.
      </p>
      <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
        <a
          href="#pricing"
          className="rounded-full bg-orange px-7 py-3.5 font-medium text-cream transition hover:brightness-95"
        >
          Start your feed — R{pricing.starter.zar}/mo
        </a>
        <Link
          href="/dashboard"
          className="rounded-full border border-cream/25 px-7 py-3.5 font-medium text-cream transition hover:border-cream/60"
        >
          See sample data
        </Link>
      </div>
      <p className="mt-5 text-xs text-cream/40">
        Billed in ZAR via Paystack · Cancel anytime
      </p>

      <div className="absolute inset-x-0 bottom-12 h-24">
        <Ticker angle={-2.5} />
        <div className="mt-9">
          <Ticker angle={1.8} reverse />
        </div>
      </div>
    </header>
  );
}

function Stats() {
  const cards = [
    { n: `${feedStats.storesTracked}`, label: "stores tracked", tone: "outline" },
    { n: `+${feedStats.newThisWeek}`, label: "new this week", tone: "mint" },
    { n: "46%", label: "with direct emails", tone: "outline" },
    { n: `${feedStats.plusFlagged}`, label: "Shopify Plus flagged", tone: "lilac" },
  ];
  return (
    <section className="px-6 pb-24">
      <div className="mx-auto grid max-w-5xl grid-cols-2 gap-3 md:grid-cols-4">
        {cards.map((c) => (
          <div
            key={c.label}
            className={`rounded-3xl px-5 py-6 ${
              c.tone === "mint"
                ? "bg-mint text-ink"
                : c.tone === "lilac"
                  ? "bg-lilac text-ink"
                  : "border border-cream/12 text-cream"
            }`}
          >
            <div className="font-display text-5xl">{c.n}</div>
            <div
              className={`mt-1 text-xs font-medium uppercase tracking-wide ${
                c.tone === "outline" ? "text-cream/45" : "opacity-70"
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

function Comparison() {
  return (
    <section className="px-6 pb-24">
      <div className="mx-auto max-w-5xl text-center">
        <h2 className="font-display text-5xl tracking-tight md:text-6xl">
          Weeks earlier <em className="text-cream/45">than everyone else.</em>
        </h2>
        <div className="mt-12 grid gap-4 md:grid-cols-2">
          <div className="rounded-[2rem] border border-cream/12 p-10 text-left">
            <div className="text-xs font-semibold uppercase tracking-wide text-cream/40">
              Directories &amp; manual research
            </div>
            <div className="mt-4 font-display text-6xl text-cream/35">
              2–6 <span className="text-2xl">weeks behind</span>
            </div>
            <p className="mt-4 text-sm text-cream/45">
              By the time a store shows up in directories, every agency has
              already emailed them.
            </p>
          </div>
          <div className="rounded-[2rem] bg-cream p-10 text-left text-ink">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-ink/50">
              <TerrainMark className="h-3.5 w-auto" /> Terrain
            </div>
            <div className="mt-4 font-display text-6xl">
              Same <span className="text-orange">day</span>
            </div>
            <p className="mt-4 text-sm text-ink/60">
              Certificate transparency shows us stores the moment they get their
              SSL certificate — often before their first sale.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

const bentoCards = [
  {
    n: "01",
    title: "24/7 discovery from certificate transparency",
    body: "The moment a new store gets its SSL certificate, we see it. No directories, no delays — we watch the internet's public certificate logs around the clock.",
    tone: "light" as const,
  },
  {
    n: "02",
    title: "Enriched with contacts & catalog data",
    body: "Direct emails, phone numbers, product counts, price ranges, themes and installed apps — everything you need to qualify and reach out.",
    tone: "dark" as const,
  },
  {
    n: "03",
    title: "Shopify Plus detection",
    body: "Multi-signal fingerprinting flags enterprise merchants — catch replatformings and big launches the day they surface.",
    tone: "dark" as const,
  },
  {
    n: "04",
    title: "Weekly delivery, your way",
    body: "An email digest every Monday, plus CSV download and a live dashboard. API access on Enterprise.",
    tone: "light" as const,
  },
];

function Bento() {
  return (
    <section id="how" className="px-4 pb-24">
      <div className="mx-auto max-w-6xl rounded-[3rem] border border-cream/10 bg-cream/[0.04] px-6 py-20 md:px-14">
        <p className="mb-10 text-xs font-semibold uppercase tracking-[0.2em] text-orange">
          How it works
        </p>
        <div className="grid gap-5 md:grid-cols-2">
          {bentoCards.map((c) => (
            <div
              key={c.n}
              className={`rounded-[2rem] p-8 md:p-10 ${
                c.tone === "light"
                  ? "bg-cream text-ink"
                  : "border border-cream/12 text-cream"
              }`}
            >
              <div className="text-sm font-semibold opacity-50">{c.n}</div>
              <h3 className="mt-14 max-w-md text-xl font-bold uppercase leading-snug tracking-tight">
                {c.title}
              </h3>
              <p
                className={`mt-4 max-w-md text-sm leading-relaxed ${
                  c.tone === "light" ? "text-ink/65" : "text-cream/55"
                }`}
              >
                {c.body}
              </p>
            </div>
          ))}
        </div>
        <div className="mt-5 rounded-[2rem] bg-orange px-8 py-12 text-center">
          <p className="font-display text-3xl text-ink-deep md:text-4xl">
            Be first to reach every new store in South Africa.
          </p>
        </div>
      </div>
    </section>
  );
}

function DashboardPreview() {
  return (
    <section id="data" className="px-6 pb-24">
      <div className="mx-auto max-w-6xl">
        <h2 className="font-display text-5xl tracking-tight md:text-6xl">
          The data, <em className="text-orange">live.</em>
        </h2>
        <p className="mt-4 max-w-xl text-cream/60">
          A sample from this week&apos;s feed — real stores, discovered within
          hours of launch.
        </p>

        <div className="mt-10 overflow-hidden rounded-[2.5rem] bg-paper p-6 text-ink md:p-8">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-ink/40">
                <tr>
                  <th className="pb-3 pr-4">Store</th>
                  <th className="pb-3 pr-4">Products</th>
                  <th className="pb-3 pr-4">Price range</th>
                  <th className="pb-3 pr-4">Contact</th>
                  <th className="pb-3">First seen</th>
                </tr>
              </thead>
              <tbody>
                {sampleLeads.slice(0, 5).map((l) => (
                  <tr key={l.domain} className="border-t border-ink/10">
                    <td className="py-3.5 pr-4">
                      <div className="font-semibold">
                        {l.name}
                        {l.plus && (
                          <span className="ml-2 rounded-full bg-lilac px-2 py-0.5 text-[10px] font-bold">
                            PLUS
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-ink/45">{l.domain}</div>
                    </td>
                    <td className="py-3.5 pr-4">{l.productCount ?? "—"}</td>
                    <td className="py-3.5 pr-4">
                      {l.priceMin != null
                        ? `R${l.priceMin}–R${l.priceMax}`
                        : "—"}
                    </td>
                    <td className="py-3.5 pr-4">
                      {l.email ? (
                        <span className="text-orange">{l.email}</span>
                      ) : (
                        <span className="text-ink/30">—</span>
                      )}
                    </td>
                    <td className="py-3.5 text-ink/55">{l.firstSeen}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}

const plans = [
  {
    key: "starter" as const,
    name: "Starter",
    price: `R${pricing.starter.zar}`,
    blurb: "For freelancers and small agencies.",
    features: [
      "Weekly email digest",
      "CSV download",
      "Contact emails included",
      "Product counts & price ranges",
    ],
    featured: false,
    cta: "Start with Starter",
  },
  {
    key: "pro" as const,
    name: "Pro",
    price: `R${pricing.pro.zar}`,
    blurb: "For teams that live on new leads.",
    features: [
      "Everything in Starter",
      "Live dashboard with filters",
      "Shopify Plus flags",
      "Same-day discovery alerts",
    ],
    featured: true,
    cta: "Go Pro",
  },
  {
    key: null,
    name: "Enterprise",
    price: "Let's talk",
    blurb: "For platforms and data teams.",
    features: [
      "API access",
      "Custom markets (Japan next)",
      "Slack delivery",
      "Historical archive",
    ],
    featured: false,
    cta: "Contact us",
  },
];

function Pricing() {
  return (
    <section id="pricing" className="px-4 pb-24">
      <div className="mx-auto max-w-6xl">
        <h2 className="text-center font-display text-5xl tracking-tight md:text-6xl">
          Simple <em className="text-orange">ZAR</em> pricing.
        </h2>
        <p className="mt-4 text-center text-cream/55">
          South African billing via Paystack. International markets via Stripe —
          coming soon.
        </p>
        <div className="mt-14 grid gap-5 md:grid-cols-3">
          {plans.map((p) => (
            <div
              key={p.name}
              className={`flex flex-col rounded-[2rem] p-8 ${
                p.featured
                  ? "bg-cream text-ink"
                  : "border border-cream/12 text-cream"
              }`}
            >
              <div className="text-sm font-semibold uppercase tracking-wide opacity-55">
                {p.name}
              </div>
              <div className="mt-3 font-display text-5xl">
                {p.price}
                {p.key && <span className="text-lg opacity-50"> /month</span>}
              </div>
              <p
                className={`mt-2 text-sm ${p.featured ? "text-ink/60" : "text-cream/55"}`}
              >
                {p.blurb}
              </p>
              <ul className="mt-6 flex-1 space-y-3 text-sm">
                {p.features.map((f) => (
                  <li key={f} className="flex gap-2">
                    <span className="text-orange">✦</span> {f}
                  </li>
                ))}
              </ul>
              <a
                href={
                  p.key ? checkoutUrl(p.key, "ZA") : "mailto:hello@tembocommerce.com"
                }
                className={`mt-8 rounded-full px-6 py-3 text-center text-sm font-medium transition ${
                  p.featured
                    ? "bg-orange text-cream hover:brightness-95"
                    : "bg-cream text-ink hover:bg-paper"
                }`}
              >
                {p.cta}
              </a>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="overflow-hidden px-6 pb-8 pt-10">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-col items-center justify-between gap-4 border-t border-cream/12 pt-8 text-sm text-cream/45 md:flex-row">
          <span>
            Terrain is part of the{" "}
            <span className="text-cream/70">Tembo Commerce</span> family
          </span>
          <span>Built in South Africa · POPIA-aware data practices</span>
          <a href="mailto:hello@tembocommerce.com" className="underline">
            hello@tembocommerce.com
          </a>
        </div>
        <div className="mt-12 flex items-center justify-center gap-6 text-cream">
          <TerrainMark className="h-[7vw] w-auto" />
          <span className="font-display text-[15vw] leading-[0.75] tracking-tight">
            Terrain
          </span>
        </div>
      </div>
    </footer>
  );
}

export default function Home() {
  return (
    <main className="pt-4">
      <div className="px-4">
        <Nav />
      </div>
      <Hero />
      <Stats />
      <Comparison />
      <Bento />
      <DashboardPreview />
      <Pricing />
      <Footer />
    </main>
  );
}
