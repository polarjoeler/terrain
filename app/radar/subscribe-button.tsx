"use client";

import { useState } from "react";

/** Starts a Radar monitoring subscription checkout for a brand and redirects to
 *  Stripe. Used on the audit results page and the customer dashboard. */
export function SubscribeButton({
  brandDomain,
  email,
  label = "Start monitoring",
  className,
}: {
  brandDomain: string;
  email?: string;
  label?: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/radar/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brandDomain, email }),
      });
      const data = await res.json();
      if (res.ok && data.url) {
        window.location.href = data.url;
        return;
      }
      setErr(data.error ?? "Could not start checkout");
    } catch {
      setErr("Network error — please try again");
    }
    setBusy(false);
  }

  return (
    <>
      <button
        onClick={go}
        disabled={busy}
        className={
          className ??
          "inline-block rounded-full bg-cyan px-7 py-3.5 font-medium text-cyan-deep transition hover:brightness-110 disabled:opacity-60"
        }
      >
        {busy ? "Starting…" : label}
      </button>
      {err && <p className="mt-2 text-sm text-orange">{err}</p>}
    </>
  );
}
