import Link from "next/link";
import { Wordmark } from "@/app/components/logo";

/** Radar, folded into Terrain's own site (decision 6 Nov: Radar folds into Terrain).
 *
 *  This replaces the standalone /radar landing page, which ran on its own near-black canvas and
 *  presented Radar as a separate product with a separate subscription. That split is what the fold
 *  undoes: the detection runs on Terrain's store universe, the evidence is Terrain's catalogue
 *  fingerprints, and the buyer is a Terrain customer. One brand, one palette, one signup.
 *
 *  Written around the four buyers who actually ask for this rather than one generic "brands"
 *  pitch, because they need different things from the same evidence — a processor needs its own
 *  book filtered, an agency needs one client watched, a regulator needs the whole market.
 */

export const metadata = {
  title: "Terrain — Catalogue fraud and clone detection",
  description:
    "Find the stores selling someone else's catalogue — matched on real product images, SKUs and prices, sorted into copies, dropship networks and legitimate multi-store operators, with the payment rails they run on.",
};

const BUYERS = [
  {
    who: "Payment providers",
    ask: "Is anyone on my rail selling a stolen catalogue?",
    how: "Filter the whole detection set to the merchants processing on your rail. We already resolve the payment providers on each store, so this is your own book, not a market report.",
  },
  {
    who: "Agencies and brand owners",
    ask: "Is anyone copying my client?",
    how: "Watch a brand's domain and see who is reselling its product images, SKUs and prices — with the first-seen date that makes a takedown stick.",
  },
  {
    who: "Commerce platforms",
    ask: "Are there clones on my platform?",
    how: "Filter to stores on your platform and see which are serving another merchant's catalogue.",
  },
  {
    who: "Regulators and banks",
    ask: "Where is catalogue fraud concentrated?",
    how: "The whole market, ranked by how many products were taken and how certain the match is, with networks shown as networks.",
  },
];

export default function FraudPage() {
  return (
    <main className="min-h-screen px-4 py-6 md:px-8">
      <div className="mx-auto max-w-4xl">
        <nav className="flex items-center justify-between">
          <Link href="/"><Wordmark size="text-xl" /></Link>
          <Link href="/login" className="text-sm text-cream/60 transition hover:text-cream">Sign in</Link>
        </nav>

        <header className="mt-16 max-w-2xl">
          <span className="rounded-full border border-orange/30 bg-orange/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-orange">
            Radar
          </span>
          <h1 className="mt-5 font-display text-4xl leading-tight md:text-5xl">
            Find the copy the day it appears
          </h1>
          <p className="mt-4 text-lg text-cream/65">
            Clone stores lift the whole catalogue — the same product images, the same SKUs, the same
            prices. That is also the evidence. Terrain fingerprints the stores it tracks and tells
            you when one is selling another&rsquo;s catalogue.
          </p>
        </header>

        <section className="mt-14">
          <h2 className="font-display text-2xl text-cream">It says what it is, not just what it found</h2>
          <p className="mt-3 max-w-2xl text-cream/60">
            Two stores sharing a catalogue is a similarity, not an accusation. Most of the time
            there is an innocent reason — a distributor family, a dropship network, one business
            running several storefronts. Radar separates those before it shows you anything, because
            a false accusation sent to a merchant costs more than a missed clone.
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {[
              ["Copying", "One store selling another's catalogue, with no sign they're the same business."],
              ["Network", "Several stores sharing one catalogue — a dropship or distributor ring."],
              ["One business", "Multiple storefronts of the same operator. Not fraud, and filtered out."],
            ].map(([t, d]) => (
              <div key={t} className="rounded-2xl border border-cream/12 bg-cream/[0.02] p-5">
                <div className="font-medium text-cream">{t}</div>
                <p className="mt-1.5 text-sm text-cream/55">{d}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-14">
          <h2 className="font-display text-2xl text-cream">Four questions, one set of evidence</h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {BUYERS.map((b) => (
              <div key={b.who} className="rounded-[2rem] border border-cream/12 bg-cream/[0.02] p-6">
                <div className="text-xs uppercase tracking-wide text-cream/40">{b.who}</div>
                <div className="mt-2 font-display text-lg text-cream">{b.ask}</div>
                <p className="mt-2 text-sm text-cream/60">{b.how}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-14 rounded-[2rem] border border-cream/12 bg-cream/[0.02] p-6">
          <h2 className="font-display text-2xl text-cream">Streamline the takedown</h2>
          <p className="mt-3 max-w-2xl text-cream/60">
            Every detection carries the evidence behind it — which images, which SKUs, which prices
            matched, and the date we first saw it. A clone that is later emptied still has its
            first-seen record, which is usually the part a host or registrar asks for.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Link href="/radar/scan"
              className="rounded-full bg-mint px-5 py-2.5 text-sm font-medium text-ink transition hover:brightness-95">
              Run a free check on a brand
            </Link>
            <Link href="/billing" className="text-sm text-cream/60 transition hover:text-cream">
              See plans →
            </Link>
          </div>
        </section>

        <p className="mt-10 max-w-2xl text-xs text-cream/35">
          Detection needs a catalogue fingerprint, so coverage follows the stores Terrain has read a
          catalogue for. A store we have not fingerprinted cannot be matched — an empty result means
          not yet covered, never proven clean.
        </p>

        <footer className="mt-14 border-t border-cream/10 py-8 text-xs text-cream/35">
          Part of Terrain. <Link href="/" className="hover:text-cream/60">heyterrain.com</Link>
        </footer>
      </div>
    </main>
  );
}
