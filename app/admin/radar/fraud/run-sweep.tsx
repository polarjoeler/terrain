"use client";

import { useState } from "react";

/** On-demand market fraud sweep trigger. Shows the result, then reloads so the
 *  new/updated detections appear. Bounded but can take ~10–40s. */
export function RunSweep({ lastRun }: { lastRun: { ranAt: string; summary: Record<string, number> } | null }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const ago = (iso: string) => {
    const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  };

  async function run() {
    setBusy(true);
    setMsg("Scanning every fingerprinted store… (this can take up to a minute)");
    try {
      const res = await fetch("/api/admin/radar/run", { method: "POST" });
      const j = await res.json();
      if (!res.ok) { setMsg(j.error ?? "Sweep failed"); setBusy(false); return; }
      setMsg(`Done — ${j.clusters} clusters, ${j.written} detections (${j.newDetections} new). Refreshing…`);
      setTimeout(() => window.location.reload(), 900);
    } catch {
      setMsg("Network error");
      setBusy(false);
    }
  }

  const s = lastRun?.summary ?? {};
  return (
    <div className="mt-6 flex flex-wrap items-center gap-3 rounded-2xl border border-cream/12 bg-cream/[0.02] px-5 py-4">
      <button
        onClick={run}
        disabled={busy}
        className="rounded-full bg-cyan px-5 py-2 text-sm font-medium text-cyan-deep transition hover:brightness-110 disabled:opacity-50"
      >
        {busy ? "Running…" : "↻ Run sweep now"}
      </button>
      <div className="text-xs text-cream/50">
        {lastRun ? (
          <>Last run <b className="text-cream/70">{ago(lastRun.ranAt)}</b>
            {typeof s.clusters === "number" && <> · {s.clusters} clusters · {s.written ?? 0} detections
              {typeof s.newDetections === "number" && s.newDetections > 0 && <span className="text-mint"> · +{s.newDetections} new</span>}</>}
          </>
        ) : (
          <>Never run on-demand — runs automatically each pipeline cycle.</>
        )}
      </div>
      {msg && <span className="text-xs text-cream/60">{msg}</span>}
    </div>
  );
}
