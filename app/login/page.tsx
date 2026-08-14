"use client";

import { useState } from "react";
import Link from "next/link";
import { Wordmark } from "@/app/components/logo";

export default function Login() {
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

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-16">
      <Link href="/" className="mb-12 text-cream">
        <Wordmark size="text-2xl" tone="cream" />
      </Link>

      <div className="w-full max-w-md rounded-[2rem] bg-paper p-8 text-ink md:p-10">
        {state === "sent" ? (
          <>
            <h1 className="font-display text-3xl">Check your inbox</h1>
            <p className="mt-3 text-sm text-ink/60">{message}</p>
            <p className="mt-2 text-sm text-ink/60">
              The link expires in 15 minutes and works once.
            </p>
            {devLink && (
              <div className="mt-6 rounded-2xl bg-mint/40 p-4 text-xs">
                <p className="font-semibold">Dev mode — no mail provider configured:</p>
                <a href={devLink} className="mt-1 block break-all text-orange underline">
                  {devLink}
                </a>
              </div>
            )}
            <button
              onClick={() => setState("idle")}
              className="mt-6 text-sm text-ink/50 underline"
            >
              Use a different email
            </button>
          </>
        ) : (
          <>
            <h1 className="font-display text-3xl">Sign in to Terrain</h1>
            <p className="mt-3 text-sm text-ink/60">
              We&apos;ll email you a link — no password needed. New here? You&apos;ll
              start your 1-week free trial after a quick card check.
            </p>
            <form onSubmit={submit} className="mt-7">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.co.za"
                className="w-full rounded-full border border-ink/15 bg-transparent px-5 py-3 text-sm outline-none placeholder:text-ink/35 focus:border-ink/50"
              />
              <button
                type="submit"
                disabled={state === "sending"}
                className="mt-3 w-full rounded-full bg-orange px-6 py-3 text-sm font-medium text-cream transition hover:brightness-95 disabled:opacity-60"
              >
                {state === "sending" ? "Sending…" : "Email me a link"}
              </button>
            </form>
            {state === "error" && (
              <p className="mt-3 text-sm text-orange">{message}</p>
            )}
          </>
        )}
      </div>
    </main>
  );
}
