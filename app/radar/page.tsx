import Link from "next/link";

export const metadata = {
  title: "Radar — Stop the clones. Cut off their money.",
  description:
    "Radar finds fraudulent clone stores impersonating your brand the day they launch, exposes the payment rails funding them, and streamlines takedown. Part of the Tembo Commerce family.",
};

/* Radar uses a crimson accent (threat/protection) on the shared dark base. */
const RED = "#e5484d";

function RadarMark({ className = "h-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 28 28" fill="none" className={className} aria-hidden>
      <circle cx="14" cy="14" r="12" stroke={RED} strokeWidth="2" opacity="0.4" />
      <circle cx="14" cy="14" r="7" stroke={RED} strokeWidth="2" opacity="0.7" />
      <circle cx="14" cy="14" r="2.5" fill={RED} />
    </svg>
  );
}

function Nav() {
  return (
    <nav className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 rounded-full border border-cream/12 bg-cream/[0.06] py-2 pl-4 pr-2 backdrop-blur sm:pl-5">
      <span className="flex items-center gap-2 text-cream">
        <RadarMark className="h-5" />
        <span className="font-semibold tracking-tight" style={{ fontSize: "1.25rem" }}>
          Radar
        </span>
      </span>
      <div className="hidden gap-7 text-sm text-cream/60 md:flex">
        <a href="#how" className="hover:text-cream">How it works</a>
        <a href="#proof" className="hover:text-cream">Proof</a>
      </div>
      <a
        href="#access"
        className="shrink-0 whitespace-nowrap rounded-full px-5 py-2.5 text-sm font-medium text-cream"
        style={{ background: RED }}
      >
        Request access
      </a>
    </nav>
  );
}

const triad = [
  {
    step: "Detect",
    title: "Find the clone the day it launches",
    body: "We watch the internet's certificate logs around the clock. The moment a fraudulent store impersonating your brand goes live, Radar sees it — often before it takes a single order. AI matches domains, logos, copy and product images to your real brand, catching clones that don't even use your name.",
  },
  {
    step: "Defund",
    title: "Cut off the money",
    body: "Detection isn't enough — we expose the payment providers and acquiring banks powering each fraudulent store, and report them to the card schemes. Cutting off the ability to take payment is what actually kills a counterfeit operation.",
  },
  {
    step: "Take down",
    title: "Streamline the takedown",
    body: "Radar compiles a ready-to-file evidence dossier — screenshots, impersonation proof, payment rails, timestamps — and streamlines the Shopify takedown, so your team acts in minutes, not days.",
  },
];

export default function Radar() {
  return (
    <main className="pt-4">
      <div className="px-4">
        <Nav />
      </div>

      {/* hero */}
      <header className="mx-auto flex max-w-4xl flex-col items-center px-6 pb-20 pt-16 text-center">
        <span
          className="mb-8 rounded-full border px-4 py-1.5 text-xs font-medium"
          style={{ borderColor: `${RED}55`, color: RED, background: `${RED}14` }}
        >
          ◎ Brand protection, at internet speed
        </span>
        <h1 className="font-display text-6xl leading-[1.0] tracking-tight md:text-8xl">
          Stop the clones.
          <br />
          <em style={{ color: RED }}>Cut off their money.</em>
        </h1>
        <p className="mt-8 max-w-xl text-lg text-cream/60">
          Radar finds fraudulent stores impersonating your brand the day they
          launch, exposes the payment rails funding them, and streamlines
          takedown — before they cost you revenue and trust.
        </p>
        <div className="mt-10">
          <a
            href="#access"
            className="rounded-full px-7 py-3.5 font-medium text-cream transition hover:brightness-95"
            style={{ background: RED }}
          >
            Request access for your brand
          </a>
        </div>
      </header>

      {/* the triad */}
      <section id="how" className="px-4 pb-24">
        <div className="mx-auto max-w-6xl">
          <p className="mb-10 text-center text-xs font-semibold uppercase tracking-[0.2em]" style={{ color: RED }}>
            Detect → Defund → Take down
          </p>
          <div className="grid gap-5 md:grid-cols-3">
            {triad.map((t, i) => (
              <div key={t.step} className="rounded-[2rem] border border-cream/12 p-8 text-cream">
                <div className="font-display text-5xl" style={{ color: RED }}>
                  0{i + 1}
                </div>
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
            <em style={{ color: RED }}>days after it launched.</em>
          </h2>
          <div className="mt-8 grid gap-4 text-left sm:grid-cols-3">
            {[
              ["Duplicated theme", "“Copy of” the brand's storefront"],
              ["250 products", "bulk-imported in 4 days"],
              ["Zero marketing stack", "no real business behind it"],
            ].map(([h, s]) => (
              <div key={h} className="rounded-2xl border border-cream/12 p-5">
                <div className="font-semibold text-cream">{h}</div>
                <div className="mt-1 text-sm text-cream/50">{s}</div>
              </div>
            ))}
          </div>
          <p className="mt-8 text-sm text-cream/50">
            Radar scored it <span style={{ color: RED }} className="font-semibold">HIGH risk</span> automatically,
            with six pieces of evidence — while four legitimate stores scored zero.
          </p>
        </div>
      </section>

      {/* who it's for + CTA */}
      <section id="access" className="px-4 pb-24">
        <div className="mx-auto max-w-4xl rounded-[3rem] p-10 text-center md:p-16" style={{ background: RED }}>
          <h2 className="font-display text-4xl tracking-tight text-cream md:text-5xl">
            For brand, legal & trust teams.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-cream/85">
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
