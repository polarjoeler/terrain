import Link from "next/link";
import { TerrainMark, Wordmark } from "@/app/components/logo";
import { CountrySelector } from "@/app/components/country-selector";
import { getFeedStats, type FeedStats } from "@/lib/sheets";
import { FreshnessStamp } from "@/app/components/freshness";

function Nav() {
  return (
    <nav className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 rounded-full border border-cream/12 bg-cream/[0.06] py-2 pl-4 pr-2 backdrop-blur sm:pl-5">
      <Link href="/" className="min-w-0 shrink text-cream">
        <Wordmark />
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
        Start free trial
      </a>
    </nav>
  );
}

/** Single full-width horizontal ticker of freshly discovered stores. */
function Ticker() {
  const items = [
    "savannathreads.co.za — found 2h ago",
    "lagosactive.ng — found 3h ago",
    "nairobihome.co.ke — found 4h ago · PLUS",
    "caperoast.co.za — found 6h ago",
    "accraskincare.gh — found 7h ago",
    "kampalakraft.ug — found 9h ago",
    "dakaratelier.sn — found 11h ago",
    "casablancahome.ma — found 13h ago",
  ];
  const line = items.join(" ✦ ") + " ✦ ";
  return (
    <div className="pointer-events-none w-full overflow-hidden border-y border-cream/10 bg-cream/[0.04] py-3 text-sm font-medium tracking-wide text-cream/55">
      <div className="ticker-track">
        <span>{line}</span>
        <span>{line}</span>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <header className="mx-auto flex max-w-4xl flex-col items-center px-6 pb-16 pt-16 text-center">
      <span className="mb-8 rounded-full border border-mint/25 bg-mint/10 px-4 py-1.5 text-xs font-medium text-mint">
        ✦ Contact details included
      </span>
      <h1 className="font-display text-6xl leading-[1.0] tracking-tight md:text-8xl">
        Every new store.
        <br />
        <em className="text-orange">Found first.</em>
      </h1>
      <p className="mt-8 max-w-xl text-lg text-cream/60">
        Terrain maps new African Shopify stores the day they go live — enriched
        with contact details, pricing, payment stacks and more — delivered to
        your inbox every week.
      </p>
      <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
        <Link
          href="/login"
          className="rounded-full bg-orange px-7 py-3.5 font-medium text-cream transition hover:brightness-95"
        >
          Start your free trial
        </Link>
        <a
          href="#data"
          className="rounded-full border border-cream/25 px-7 py-3.5 font-medium text-cream transition hover:border-cream/60"
        >
          See the data
        </a>
      </div>
      <p className="mt-5 text-xs text-cream/40">
        1-week free trial · Credit card required · Cancel anytime
      </p>
      <CountrySelector />
    </header>
  );
}

function Stats({ stats }: { stats: FeedStats }) {
  const cards = [
    { n: `${stats.storesTracked.toLocaleString()}`, label: "stores tracked", tone: "outline" },
    { n: `+${stats.newThisWeek}`, label: "new this week", tone: "mint" },
    { n: `${stats.withEmailPct}%`, label: "with direct emails", tone: "outline" },
    { n: `${stats.plusFlagged}`, label: "Shopify Plus flagged", tone: "lilac" },
  ];
  return (
    <section className="px-6 py-24">
      <div className="mx-auto grid max-w-5xl grid-cols-2 gap-3 md:grid-cols-4">
        {cards.map((c) => (
          <div
            key={c.label}
            className={`rounded-3xl px-5 py-8 ${
              c.tone === "mint"
                ? "bg-mint text-ink"
                : c.tone === "lilac"
                  ? "bg-lilac text-ink"
                  : "border border-cream/12 text-cream"
            }`}
          >
            <div className="font-display text-6xl leading-none tracking-tight md:text-8xl">
              {c.n}
            </div>
            <div
              className={`mt-3 text-xs font-medium uppercase tracking-wide ${
                c.tone === "outline" ? "text-cream/45" : "opacity-70"
              }`}
            >
              {c.label}
            </div>
          </div>
        ))}
      </div>
      <div className="mx-auto mt-6 flex max-w-5xl justify-center">
        <FreshnessStamp updatedAt={stats.updatedAt} live={stats.live} />
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
  {
    n: "05",
    title: "Market-share intelligence",
    body: "See which payment providers, shipping apps and themes are winning across Africa — plus the agencies and service providers building the most new stores.",
    tone: "mint" as const,
  },
  {
    n: "06",
    title: "Brand & fraud monitoring",
    body: "We flag clone and fraudulent stores impersonating your brand, so you can protect your customers and your reputation before it costs you.",
    tone: "lilac" as const,
  },
];

function Bento() {
  const cls = (tone: string) =>
    tone === "light"
      ? "bg-cream text-ink"
      : tone === "mint"
        ? "bg-mint text-ink"
        : tone === "lilac"
          ? "bg-lilac text-ink"
          : "border border-cream/12 text-cream";
  return (
    <section id="how" className="px-4 pb-24">
      <div className="mx-auto max-w-6xl rounded-[3rem] border border-cream/10 bg-cream/[0.04] px-6 py-20 md:px-14">
        <p className="mb-10 text-xs font-semibold uppercase tracking-[0.2em] text-orange">
          What you get
        </p>
        <div className="grid gap-5 md:grid-cols-2">
          {bentoCards.map((c) => (
            <div key={c.n} className={`rounded-[2rem] p-8 md:p-10 ${cls(c.tone)}`}>
              <div className="text-sm font-semibold opacity-50">{c.n}</div>
              <h3 className="mt-14 max-w-md text-xl font-bold uppercase leading-snug tracking-tight">
                {c.title}
              </h3>
              <p
                className={`mt-4 max-w-md text-sm leading-relaxed ${
                  c.tone === "dark" ? "text-cream/55" : "text-ink/65"
                }`}
              >
                {c.body}
              </p>
            </div>
          ))}
        </div>
        <div className="mt-5 rounded-[2rem] bg-orange px-8 py-12 text-center">
          <p className="font-display text-3xl text-ink-deep md:text-4xl">
            Be the first to reach every store in Africa.
          </p>
        </div>
      </div>
    </section>
  );
}

type MockLead = {
  name: string;
  domain: string;
  products: number;
  price: string;
  payments: string[];
  revenue: string;
  email: string;
  seen: string;
  plus?: boolean;
};

const mockLeads: MockLead[] = [
  {
    name: "Savanna Threads",
    domain: "savannathreads.co.za",
    products: 142,
    price: "R199–R2,450",
    payments: ["PayFast", "Yoco", "Shop Pay"],
    revenue: "$18k–$32k/mo",
    email: "hello@savannathreads.co.za",
    seen: "2h ago",
  },
  {
    name: "Lagos Active",
    domain: "lagosactive.ng",
    products: 88,
    price: "₦8,500–₦95,000",
    payments: ["Paystack", "Flutterwave"],
    revenue: "$40k–$75k/mo",
    email: "team@lagosactive.ng",
    seen: "3h ago",
    plus: true,
  },
  {
    name: "Nairobi Home Co.",
    domain: "nairobihome.co.ke",
    products: 210,
    price: "KSh1,200–KSh38,000",
    payments: ["M-Pesa", "Flutterwave"],
    revenue: "$25k–$50k/mo",
    email: "sales@nairobihome.co.ke",
    seen: "4h ago",
  },
  {
    name: "Cape Roast",
    domain: "caperoast.co.za",
    products: 36,
    price: "R85–R690",
    payments: ["PayFast", "Ozow", "Shop Pay"],
    revenue: "$6k–$12k/mo",
    email: "orders@caperoast.co.za",
    seen: "6h ago",
  },
  {
    name: "Accra Skincare",
    domain: "accraskincare.gh",
    products: 54,
    price: "₵45–₵520",
    payments: ["Paystack", "Hubtel"],
    revenue: "$9k–$20k/mo",
    email: "hello@accraskincare.gh",
    seen: "7h ago",
  },
];

function DashboardPreview() {
  return (
    <section id="data" className="px-6 pb-24">
      <div className="mx-auto max-w-6xl">
        <h2 className="font-display text-5xl tracking-tight md:text-6xl">
          The data, <em className="text-orange">live.</em>
        </h2>
        <p className="mt-4 max-w-xl text-cream/60">
          A sample of what lands in your feed — every store enriched with
          contacts, pricing and its live payment stack, ready to act on.
        </p>

        <div className="mt-10 overflow-hidden rounded-[2.5rem] bg-paper p-6 text-ink md:p-8">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-ink/40">
                <tr>
                  <th className="pb-3 pr-4">Store</th>
                  <th className="pb-3 pr-4">Products</th>
                  <th className="pb-3 pr-4">Price range</th>
                  <th className="pb-3 pr-4">Payments</th>
                  <th className="pb-3 pr-4">Est. revenue</th>
                  <th className="pb-3 pr-4">Contact</th>
                  <th className="pb-3">Found</th>
                </tr>
              </thead>
              <tbody>
                {mockLeads.map((l) => (
                  <tr key={l.domain} className="border-t border-ink/10 align-top">
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
                    <td className="py-3.5 pr-4">{l.products}</td>
                    <td className="py-3.5 pr-4 whitespace-nowrap">{l.price}</td>
                    <td className="py-3.5 pr-4">
                      <div className="flex flex-wrap gap-1">
                        {l.payments.map((p) => (
                          <span
                            key={p}
                            className="rounded-full bg-mint/50 px-2 py-0.5 text-[10px] font-medium"
                          >
                            {p}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="py-3.5 pr-4 whitespace-nowrap font-medium">
                      {l.revenue}
                    </td>
                    <td className="py-3.5 pr-4 text-orange">{l.email}</td>
                    <td className="py-3.5 text-ink/55 whitespace-nowrap">{l.seen}</td>
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
    name: "Starter",
    price: "$30",
    soon: "$50",
    blurb: "For freelancers and small agencies.",
    features: [
      "Weekly email digest",
      "CSV download",
      "Contact emails included",
      "Product counts & price ranges",
    ],
    featured: false,
    cta: "Start with Starter",
    href: "/login",
  },
  {
    name: "Pro",
    price: "$79",
    soon: "$100",
    blurb: "For teams that live on new leads.",
    features: [
      "Everything in Starter",
      "Live dashboard with filters",
      "Market-share intelligence",
      "Brand & fraud monitoring",
    ],
    featured: true,
    cta: "Go Pro",
    href: "/login",
  },
  {
    name: "Enterprise",
    price: "Let's talk",
    soon: null,
    blurb: "For platforms and data teams.",
    features: [
      "API access",
      "Custom markets",
      "Slack delivery",
      "Historical archive",
    ],
    featured: false,
    cta: "Contact us",
    href: "mailto:hello@tembocommerce.com",
  },
];

function Pricing() {
  return (
    <section id="pricing" className="px-4 pb-24">
      <div className="mx-auto max-w-6xl">
        <h2 className="text-center font-display text-5xl tracking-tight md:text-6xl">
          Simple <em className="text-orange">introductory</em> pricing.
        </h2>
        <p className="mt-4 text-center text-cream/55">
          Lock in the launch price before it goes up. Billed in USD via Stripe.
        </p>
        <div className="mt-14 grid gap-5 md:grid-cols-3">
          {plans.map((p) => (
            <div
              key={p.name}
              className={`flex flex-col rounded-[2rem] p-8 ${
                p.featured ? "bg-cream text-ink" : "border border-cream/12 text-cream"
              }`}
            >
              <div className="text-sm font-semibold uppercase tracking-wide opacity-55">
                {p.name}
              </div>
              <div className="mt-3 font-display text-5xl">
                {p.price}
                {p.soon && <span className="text-lg opacity-50"> /month</span>}
              </div>
              {p.soon && (
                <div className="mt-1.5 text-sm font-medium text-orange">
                  Introductory — {p.soon}/mo soon
                </div>
              )}
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
                href={p.href}
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
        <p className="mt-8 text-center text-sm text-cream/45">
          Every plan starts with a <span className="text-cream/70">1-week free
          trial</span> — credit card required, cancel anytime.
        </p>
      </div>
    </section>
  );
}

const integrations = [
  { name: "Apollo", desc: "Push new stores straight into your Apollo sequences." },
  { name: "HubSpot", desc: "Create contacts and deals from fresh leads automatically." },
  { name: "Salesforce", desc: "Sync qualified stores into your pipeline in real time." },
];

function ComingSoon() {
  return (
    <section className="px-6 pb-24">
      <div className="mx-auto max-w-6xl rounded-[3rem] border border-cream/10 bg-cream/[0.04] px-6 py-16 md:px-14">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-display text-4xl tracking-tight md:text-5xl">
            Sync to your sales stack.
          </h2>
          <span className="rounded-full border border-mint/25 bg-mint/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-mint">
            Coming soon
          </span>
        </div>
        <p className="mt-3 max-w-xl text-cream/55">
          One-click integrations to send new leads into the tools your team
          already lives in.
        </p>
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          {integrations.map((i) => (
            <div
              key={i.name}
              className="rounded-[1.75rem] border border-cream/12 p-7 text-cream"
            >
              <div className="text-lg font-semibold">{i.name}</div>
              <p className="mt-2 text-sm text-cream/55">{i.desc}</p>
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
          <Link href="/" className="text-cream/80">
            <Wordmark size="text-base" />
          </Link>
          <span>
            Part of the{" "}
            <span className="text-cream/70">Tembo Commerce</span> family · Built
            in Cape Town 🧡
          </span>
          <a href="mailto:hello@tembocommerce.com" className="underline">
            hello@tembocommerce.com
          </a>
        </div>
      </div>
    </footer>
  );
}

// ISR: regenerate the homepage (and its live stats) at most every 15 minutes,
// so the numbers track the growing feed without a Sheets hit per visitor.
export const revalidate = 900;

export default async function Home() {
  const stats = await getFeedStats();
  return (
    <main className="pt-4">
      <div className="px-4">
        <Nav />
      </div>
      <Hero />
      <Ticker />
      <Stats stats={stats} />
      <Comparison />
      <Bento />
      <DashboardPreview />
      <ComingSoon />
      <Pricing />
      <Footer />
    </main>
  );
}
