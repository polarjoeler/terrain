"use client";

import { useCallback, useEffect, useState } from "react";

/** Reset the Insights baseline — click AFTER a bulk import (once the liveness
 *  sweep has settled) so the batch lands as a level-shift, not fake growth/churn. */
export function BaselineReset() {
  const [baseline, setBaseline] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/insights-baseline");
      const data = await res.json();
      if (res.ok) setBaseline(data.baseline ?? null);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function reset() {
    if (!confirm("Reset the Insights baseline to today? Trends & forward-churn will restart from now. Do this after a bulk import has settled.")) {
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/insights-baseline", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setBaseline(data.baseline);
        setMsg(`Baseline reset to ${data.baseline}.`);
      } else {
        setMsg(data.error ?? "Reset failed");
      }
    } catch {
      setMsg("Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-12 rounded-3xl border border-cream/12 p-6 md:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl">Insights baseline</h2>
          <p className="mt-1 max-w-md text-sm text-cream/55">
            Insights trends &amp; forward-churn are measured from this date. Reset it
            <span className="text-cream/75"> after a bulk import</span> (once the liveness
            sweep has settled) so the batch doesn&apos;t show up as fake growth or churn.
          </p>
          <p className="mt-3 text-sm text-cream/70">
            Current baseline:{" "}
            <span className="font-semibold text-cream">{baseline ?? "since first snapshot"}</span>
          </p>
          {msg && <p className="mt-2 text-sm text-mint">{msg}</p>}
        </div>
        <button
          onClick={reset}
          disabled={busy}
          className="shrink-0 rounded-full border border-orange/40 bg-orange/10 px-5 py-2.5 text-sm font-medium text-orange transition hover:bg-orange/20 disabled:opacity-60"
        >
          {busy ? "Resetting…" : "Reset baseline to today"}
        </button>
      </div>
    </section>
  );
}
