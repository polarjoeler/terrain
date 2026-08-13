"use client";

import { useState } from "react";
import Link from "next/link";
import { Wordmark } from "@/app/components/logo";

const PLANS = [
  { key: "starter", name: "Starter", price: "R499", blurb: "Weekly digest + CSV export" },
  { key: "pro", name: "Pro", price: "R999", blurb: "Live dashboard, Plus flags, alerts" },
] as const;

export default function Billing() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function subscribe(plan: string) {
    setBusy(plan);
    setError("");
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      const json = await res.json();
      if (!res.ok || !json.url) {
        setError(json.error ?? "Could not start checkout");
        setBusy(null);
        return;
      }
      window.location.href = json.url;
    } catch {
      setError("Network error — try again");
      setBusy(null);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-16">
      <Link href="/" className="mb-10 text-cream">
        <Wordmark size="text-2xl" tone="cream" />
      </Link>

      <div className="w-full max-w-2xl">
        <h1 className="text-center font-display text-4xl md:text-5xl">
          Your trial has ended.
        </h1>
        <p className="mt-3 text-center text-cream/60">
          Subscribe to keep receiving new stores as they launch.
        </p>

        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          {PLANS.map((p) => (
            <div key={p.key} className="rounded-[2rem] bg-paper p-8 text-ink">
              <div className="text-sm font-semibold uppercase tracking-wide opacity-55">
                {p.name}
              </div>
              <div className="mt-2 font-display text-4xl">
                {p.price}
                <span className="text-base opacity-50"> /month</span>
              </div>
              <p className="mt-2 text-sm text-ink/60">{p.blurb}</p>
              <button
                onClick={() => subscribe(p.key)}
                disabled={busy !== null}
                className="mt-6 w-full rounded-full bg-orange px-6 py-3 text-sm font-medium text-cream transition hover:brightness-95 disabled:opacity-60"
              >
                {busy === p.key ? "Redirecting…" : `Subscribe — ${p.price}/mo`}
              </button>
            </div>
          ))}
        </div>

        {error && <p className="mt-5 text-center text-sm text-orange">{error}</p>}

        <p className="mt-8 text-center text-xs text-cream/40">
          Secure payment via Paystack · Cancel anytime · Billed in ZAR
        </p>
      </div>
    </main>
  );
}
