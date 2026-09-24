"use client";
import { useState } from "react";

// Holding-page newsletter capture → POSTs to /api/subscribe (Beehiiv), tagged by region so the
// Africa and Japan audiences segment cleanly. Defaults to the Africa/global market.
export function NewsletterCTA({ region = "africa" }: { region?: "africa" | "japan" }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || state === "loading") return;
    setState("loading"); setMsg("");
    try {
      const res = await fetch("/api/subscribe", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, region }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
      setState("done"); setEmail("");
    } catch (err) {
      setState("error"); setMsg(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

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
            placeholder="you@company.com" aria-label="Email address" disabled={state === "done"}
            className="min-w-[220px] flex-1 rounded-full border border-cream/15 bg-ink-deep/50 px-5 py-3.5 text-cream outline-none focus:border-cyan disabled:opacity-60" />
          <button type="submit" disabled={state === "loading" || state === "done"}
            className="rounded-full bg-cyan px-6 py-3.5 font-medium text-cyan-deep transition hover:brightness-110 disabled:opacity-60">
            {state === "loading" ? "Adding you…" : "Keep me posted →"}
          </button>
        </form>
        <div className="mt-4 min-h-[20px] text-sm">
          {state === "done" && <span className="text-mint">Thanks — you&apos;re on the early list ✦</span>}
          {state === "error" && <span className="text-orange">{msg}</span>}
        </div>
      </div>
    </section>
  );
}
