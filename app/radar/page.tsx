import Link from "next/link";

export const metadata = {
  title: "Radar — Real-time brand protection",
  description:
    "Radar monitors for fraudulent stores copying your brand in real time — your images, copy, pricing, variations and stock — exposes the payment rails funding them, and streamlines takedown. Part of the Tembo Commerce family.",
};

function RadarMark({ className = "h-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 28 28" fill="none" className={className} aria-hidden>
      <circle cx="14" cy="14" r="12" stroke="var(--color-cyan)" strokeWidth="2" opacity="0.35" />
      <circle cx="14" cy="14" r="7" stroke="var(--color-cyan)" strokeWidth="2" opacity="0.6" />
      <circle cx="14" cy="14" r="2.5" fill="var(--color-cyan)" />
    </svg>
  );
}

/* Animated monitoring scope: rotating sweep + pulsing detection blips. */
const blips = [
  { top: "30%", left: "63%", label: "burntstudiospro.co.za", hot: true },
  { top: "60%", left: "36%", label: "n1ke-outlet.shop", hot: true },
  { top: "44%", left: "72%", label: null, hot: false },
  { top: "70%", left: "58%", label: null, hot: false },
  { top: "35%", left: "42%", label: null, hot: false },
];

function RadarScope() {
  return (
    <div className="relative mx-auto aspect-square w-full max-w-sm">
      {[0, 18, 36].map((i) => (
        <div
          key={i}
          className="absolute rounded-full border border-cyan/20"
          style={{ inset: `${i}%` }}
        />
      ))}
      <div className="absolute inset-x-0 top-1/2 h-px bg-cyan/10" />
      <div className="absolute inset-y-0 left-1/2 w-px bg-cyan/10" />
      <div
        className="radar-sweep absolute inset-0 rounded-full"
        style={{
          background:
            "conic-gradient(from 0deg, transparent 300deg, rgba(76,201,212,0.18) 350deg, rgba(76,201,212,0.55) 360deg)",
        }}
      />
      <div className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan" />
      {blips.map((b, i) => (
        <div
          key={i}
          className="absolute -translate-x-1/2 -translate-y-1/2"
          style={{ top: b.top, left: b.left }}
        >
          <div
            className={`relative h-2.5 w-2.5 rounded-full ${
              b.hot ? "bg-cyan blip-pulse" : "bg-cyan/40"
            }`}
          />
          {b.label && (
            <span className="absolute left-4 top-1/2 -translate-y-1/2 whitespace-nowrap rounded bg-ink-deep/90 px-1.5 py-0.5 text-[10px] font-medium text-cyan">
              {b.label}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function DetectionTicker() {
  const items = [
    "burntstudiospro.co.za — clone detected · HIGH",
    "n1ke-outlet.shop — impersonation · HIGH",
    "adidas-sale-za.com — flagged for review",
    "woolworths-clearance.shop — clone detected",
    "superbalist-outlet.co.za — impersonation",
    "takealot-deals.store — flagged for review",
  ];
  const line = items.join("  ◎  ") + "  ◎  ";
  return (
    <div className="pointer-events-none w-full overflow-hidden border-y border-cyan/10 bg-cyan/[0.04] py-3 text-sm font-medium tracking-wide text-cyan/70">
      <div className="ticker-track">
        <span>{line}</span>
        <span>{line}</span>
      </div>
    </div>
  );
}

function Nav() {
  return (
    <nav className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 rounded-full border border-cream/12 bg-cream/[0.06] py-2 pl-4 pr-2 backdrop-blur sm:pl-5">
      <span className="flex items-center gap-2 text-cream">
        <RadarMark className="h-5" />
        <span className="text-xl font-semibold tracking-tight">Radar</span>
      </span>
      <div className="hidden gap-7 text-sm text-cream/60 md:flex">
        <a href="#how" className="hover:text-cream">How it works</a>
        <a href="#proof" className="hover:text-cream">Proof</a>
      </div>
      <a
        href="#access"
        className="shrink-0 whitespace-nowrap rounded-full bg-cyan px-5 py-2.5 text-sm font-medium text-cyan-deep"
      >
        Request access
      </a>
    </nav>
  );
}

const triad = [
  {
    step: "Detect",
    title: "Find the copy the day it appears",
    body: "We watch certificate logs around the clock and fingerprint your brand — domains, logos, copy, product images. The moment a store copies you, Radar sees it, often before it takes an order.",
  },
  {
    step: "Defund",
    title: "Cut off the money",
    body: "We expose the payment providers and acquiring banks powering each fraudulent store and report them to the card schemes. Cutting off payment is what actually kills a counterfeit operation.",
  },
  {
    step: "Take down",
    title: "Streamline the takedown",
    body: "Radar compiles a ready-to-file evidence dossier — screenshots, impersonation proof, payment rails, timestamps — and streamlines the Shopify takedown, so your team acts in minutes.",
  },
];

export default function Radar() {
  return (
    <main className="pt-4">
      <div className="px-4">
        <Nav />
      </div>

      {/* hero */}
      <header className="mx-auto max-w-6xl px-6 pb-16 pt-14">
        <div className="grid items-center gap-12 md:grid-cols-2">
          <div className="text-center md:text-left">
            <span className="mb-6 inline-block rounded-full border border-cyan/30 bg-cyan/10 px-4 py-1.5 text-xs font-medium text-cyan">
              ◎ Real-time brand protection
            </span>
            <h1 className="font-display text-5xl leading-[1.02] tracking-tight md:text-7xl">
              Stop the clones.
              <br />
              <em className="text-cyan">Cut off their money.</em>
            </h1>
            <p className="mt-7 max-w-lg text-lg text-cream/60">
              In South Africa, hundreds of new online stores launch every week —
              and it&apos;s never been easier to grab your images, copy, pricing,
              variations and stock counts straight from your store&apos;s API.
              Radar monitors for it in real time.
            </p>
            <div className="mt-6 inline-flex items-center gap-2 rounded-2xl border border-cyan/20 bg-cyan/[0.06] px-4 py-2.5 text-sm">
              <span className="h-2 w-2 rounded-full bg-cyan blip-pulse" />
              <span className="text-cream/80">
                Last week we spotted{" "}
                <span className="font-semibold text-cyan">2 top-50 brands</span>{" "}
                being copied.
              </span>
            </div>
            <div className="mt-8">
              <a
                href="#access"
                className="rounded-full bg-cyan px-7 py-3.5 font-medium text-cyan-deep transition hover:brightness-110"
              >
                Request access for your brand
              </a>
            </div>
          </div>
          <RadarScope />
        </div>
      </header>

      <DetectionTicker />

      {/* triad */}
      <section id="how" className="px-4 py-24">
        <div className="mx-auto max-w-6xl">
          <p className="mb-10 text-center text-xs font-semibold uppercase tracking-[0.2em] text-cyan">
            Detect → Defund → Take down
          </p>
          <div className="grid gap-5 md:grid-cols-3">
            {triad.map((t, i) => (
              <div key={t.step} className="rounded-[2rem] border border-cream/12 p-8 text-cream">
                <div className="font-display text-5xl text-cyan">0{i + 1}</div>
                <div className="mt-6 text-xs font-bold uppercase tracking-wide text-cream/50">
                  {t.step}
                </div>
                <h3 className="mt-2 text-xl font-bold leading-snug">{t.title}</h3>
                <p className="mt-3 text-sm leading-relaxed text-cream/60">{t.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* proof */}
      <section id="proof" className="px-4 pb-24">
        <div className="mx-auto max-w-4xl rounded-[3rem] border border-cream/10 bg-cream/[0.04] px-6 py-16 text-center md:px-14">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cream/40">
            Real detection
          </p>
          <h2 className="mt-4 font-display text-4xl tracking-tight md:text-5xl">
            We caught a live clone of a real SA brand —{" "}
            <em className="text-cyan">days after it launched.</em>
          </h2>
          <div className="mt-8 grid gap-4 text-left sm:grid-cols-3">
            {[
              ["Duplicated theme", "“Copy of” the brand's storefront"],
              ["250 products", "bulk-imported in 4 days via API"],
              ["Zero marketing stack", "no real business behind it"],
            ].map(([h, s]) => (
              <div key={h} className="rounded-2xl border border-cream/12 p-5">
                <div className="font-semibold text-cream">{h}</div>
                <div className="mt-1 text-sm text-cream/50">{s}</div>
              </div>
            ))}
          </div>
          <p className="mt-8 text-sm text-cream/50">
            Radar scored it{" "}
            <span className="font-semibold text-cyan">HIGH risk</span> automatically,
            with six pieces of evidence — while legitimate stores scored zero.
          </p>
        </div>
      </section>

      {/* CTA */}
      <section id="access" className="px-4 pb-24">
        <div className="mx-auto max-w-4xl rounded-[3rem] bg-cyan p-10 text-center text-cyan-deep md:p-16">
          <h2 className="font-display text-4xl tracking-tight md:text-5xl">
            For brand, legal &amp; trust teams.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-cyan-deep/80">
            Every day a counterfeit store is live is measurable revenue and
            trademark damage. Radar turns detection into resolution.
          </p>
          <a
            href="mailto:hello@tembocommerce.com?subject=Radar%20access"
            className="mt-8 inline-block rounded-full bg-ink-deep px-7 py-3.5 font-medium text-cream transition hover:brightness-110"
          >
            Request access
          </a>
        </div>
      </section>

      <footer className="px-6 pb-10 pt-4">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 border-t border-cream/12 pt-8 text-sm text-cream/45 md:flex-row">
          <span className="flex items-center gap-2 text-cream/70">
            <RadarMark className="h-4" /> Radar
          </span>
          <span>
            Part of the <span className="text-cream/70">Tembo Commerce</span> family ·
            Built in Cape Town 🧡
          </span>
          <Link href="/" className="underline">
            Terrain →
          </Link>
        </div>
      </footer>
    </main>
  );
}
