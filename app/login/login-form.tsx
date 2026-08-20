"use client";

import { useState } from "react";
import Link from "next/link";
import { Wordmark } from "@/app/components/logo";

export function LoginForm({ radar = false }: { radar?: boolean }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");
  const [devLink, setDevLink] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    setDevLink(null);
    try {
      const res = await fetch("/api/auth/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const json = await res.json();
      if (!res.ok) {
        setState("error");
        setMessage(json.error ?? "Something went wrong");
        return;
      }
      setState("sent");
      setMessage(json.message);
      if (json.devPreview) setDevLink(json.devPreview);
    } catch {
      setState("error");
      setMessage("Network error — try again");
    }
  }

  const btn = radar
    ? "bg-cyan text-cyan-deep hover:brightness-110"
    : "bg-orange text-cream hover:brightness-95";

  return (
    <main
      className={`flex min-h-screen flex-col items-center justify-center px-6 py-16 ${radar ? "bg-[#0b0e10]" : ""}`}
    >
      <Link href="/" className="mb-12 text-cream">
        {radar ? (
          <span className="text-2xl font-semibold tracking-tight text-cream">◎ Radar</span>
        ) : (
          <Wordmark size="text-2xl" tone="cream" />
        )}
      </Link>

      <div
        className={`w-full max-w-md rounded-[2rem] p-8 md:p-10 ${radar ? "border border-cream/12 bg-cream/[0.03] text-cream" : "bg-paper text-ink"}`}
      >
        {state === "sent" ? (
          <>
            <h1 className="font-display text-3xl">Check your inbox</h1>
            <p className={`mt-3 text-sm ${radar ? "text-cream/60" : "text-ink/60"}`}>{message}</p>
            <p className={`mt-2 text-sm ${radar ? "text-cream/60" : "text-ink/60"}`}>
              The link expires in 15 minutes and works once.
            </p>
            {devLink && (
              <div className="mt-6 rounded-2xl bg-mint/40 p-4 text-xs text-ink">
                <p className="font-semibold">Dev mode — no mail provider configured:</p>
                <a href={devLink} className="mt-1 block break-all text-orange underline">{devLink}</a>
              </div>
            )}
            <button onClick={() => setState("idle")} className={`mt-6 text-sm underline ${radar ? "text-cream/50" : "text-ink/50"}`}>
              Use a different email
            </button>
          </>
        ) : (
          <>
            <h1 className="font-display text-3xl">Sign in to {radar ? "Radar" : "Terrain"}</h1>
            <p className={`mt-3 text-sm ${radar ? "text-cream/60" : "text-ink/60"}`}>
              {radar
                ? "We'll email you a link — no password needed. Sign in to see who's copying your catalogue and manage your brand protection."
                : "We'll email you a link — no password needed. New here? You'll start your 1-week free trial after a quick card check."}
            </p>
            <form onSubmit={submit} className="mt-7">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={radar ? "you@yourbrand.com" : "you@company.co.za"}
                className={`w-full rounded-full border bg-transparent px-5 py-3 text-sm outline-none ${radar ? "border-cream/20 text-cream placeholder:text-cream/35 focus:border-cyan/60" : "border-ink/15 text-ink placeholder:text-ink/35 focus:border-ink/50"}`}
              />
              <button
                type="submit"
                disabled={state === "sending"}
                className={`mt-3 w-full rounded-full px-6 py-3 text-sm font-medium transition disabled:opacity-60 ${btn}`}
              >
                {state === "sending" ? "Sending…" : "Email me a link"}
              </button>
            </form>
            {state === "error" && <p className="mt-3 text-sm text-orange">{message}</p>}
          </>
        )}
      </div>
    </main>
  );
}
