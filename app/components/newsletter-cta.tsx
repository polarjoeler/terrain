"use client";
import { useState } from "react";

// Holding-page newsletter capture. NOTE: not yet wired to a mailing list — on submit it just shows
// a local success state. Point `submit()` at the real endpoint (Mailchimp/Beehiiv/our API) when the
// backend is decided.
export function NewsletterCTA() {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    setDone(true); // TODO: POST to the real newsletter endpoint
    setEmail("");
  };
  return (
    <section id="join" className="px-4 pb-24">
      <div className="mx-auto max-w-4xl rounded-[2.5rem] border border-cream/12 bg-gradient-to-br from-cyan/[0.10] to-lilac/[0.06] px-6 py-16 text-center md:px-14">
        <span className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan">Coming soon</span>
        <h2 className="mt-3 font-display text-4xl tracking-tight md:text-5xl">Get the African commerce briefing.</h2>
        <p className="mx-auto mt-4 max-w-xl text-cream/60">
          We&apos;re opening Terrain to a first group of partners. Leave your email for launch access and the occasional data-backed read on where African eCommerce is heading.
        </p>
        <form onSubmit={submit} className="mx-auto mt-8 flex max-w-md flex-wrap justify-center gap-3">
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com" aria-label="Email address"
            className="min-w-[220px] flex-1 rounded-full border border-cream/15 bg-ink-deep/50 px-5 py-3.5 text-cream outline-none focus:border-cyan" />
          <button type="submit" className="rounded-full bg-cyan px-6 py-3.5 font-medium text-cyan-deep transition hover:brightness-110">
            Keep me posted →
          </button>
        </form>
        <div className="mt-4 min-h-[20px] text-sm text-mint">{done ? "Thanks — you're on the early list ✦" : ""}</div>
        <p className="mt-1 text-[11px] text-cream/35">Mock-up — the form isn&apos;t connected to a mailing list yet.</p>
      </div>
    </section>
  );
}
