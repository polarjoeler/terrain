"use client";

import { useState } from "react";
import Link from "next/link";
import type { FraudCluster } from "@/lib/radar/fraud";
import { Outreach } from "./outreach";

const usd = (n: number | null) =>
  n == null ? null : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M/mo` : n >= 1e3 ? `$${Math.round(n / 1e3)}k/mo` : `$${Math.round(n)}/mo`;
const ago = (iso: string) => {
  const d = (Date.now() - new Date(iso).getTime()) / 864e5;
  if (d < 1) return "today";
  if (d < 2) return "yesterday";
  if (d < 30) return `${Math.floor(d)}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};

export function FraudClusterCard({ cluster }: { cluster: FraudCluster }) {
  const [clones, setClones] = useState(cluster.clones);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);

  async function dismiss(suspect?: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/radar/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ victim: cluster.victim, suspect }),
      });
      if (!res.ok) return;
      if (suspect) setClones((c) => c.filter((x) => x.suspect !== suspect));
      else setHidden(true);
    } finally {
      setBusy(false);
    }
  }

  if (hidden || clones.length === 0) return null;

  return (
    <section className="rounded-[2rem] border border-cream/12 bg-cream/[0.02] p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-xl text-cream">{cluster.victimName || cluster.victim}</h2>
            {cluster.enrolled ? (
              <span className="rounded-full bg-mint/20 px-2.5 py-0.5 text-[10px] font-bold uppercase text-mint">Customer</span>
            ) : (
              <span className="rounded-full bg-cyan/15 px-2.5 py-0.5 text-[10px] font-bold uppercase text-cyan">Lead</span>
            )}
          </div>
          <a href={`https://${cluster.victim}`} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-cream/45 hover:underline">
            {cluster.victim}
          </a>
          {usd(cluster.estSales) && <span className="ml-2 text-xs text-cream/40">· {usd(cluster.estSales)}</span>}
        </div>
        <div className="flex items-center gap-2">
          <span className="shrink-0 rounded-full bg-orange/15 px-3 py-1 text-xs font-bold text-orange">
            {clones.length} clone{clones.length === 1 ? "" : "s"}
          </span>
          <button
            onClick={() => dismiss()}
            disabled={busy}
            title="Not a clone — dismiss this whole cluster (the sweep won't resurface it)"
            className="rounded-full border border-cream/20 px-3 py-1 text-xs text-cream/50 transition hover:border-orange/50 hover:text-orange disabled:opacity-40"
          >
            Not a clone
          </button>
        </div>
      </div>

      <ul className="mt-4 space-y-2">
        {clones.map((cl) => (
          <li key={cl.suspect} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-cream/10 px-4 py-2.5">
            <div className="min-w-0">
              <a href={`https://${cl.suspect}`} target="_blank" rel="noopener noreferrer" className="font-mono text-sm text-cream hover:underline">
                {cl.suspect}
              </a>
              <div className="text-[11px] text-cream/40">
                {cl.reasons[0] ?? "catalogue match"} · detected {ago(cl.firstSeen)}
                {cl.at.slice(0, 10) !== cl.firstSeen.slice(0, 10) && <> · confirmed {ago(cl.at)}</>}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-cyan/15 px-2.5 py-0.5 text-[11px] font-bold text-cyan">{cl.verdict} · {cl.score}</span>
              <Link
                href={`/radar/dossier/${encodeURIComponent(cluster.victim)}/${encodeURIComponent(cl.suspect)}`}
                className="text-[11px] font-medium text-cyan hover:underline"
              >
                Dossier →
              </Link>
              <button
                onClick={() => dismiss(cl.suspect)}
                disabled={busy}
                title="Dismiss this one (not a clone)"
                className="text-[11px] text-cream/35 transition hover:text-orange disabled:opacity-40"
              >
                ✕ dismiss
              </button>
            </div>
          </li>
        ))}
      </ul>

      {!cluster.enrolled && (
        <Outreach
          victim={cluster.victim}
          victimName={cluster.victimName}
          victimEmail={cluster.victimEmail}
          clones={clones.map((x) => x.suspect)}
        />
      )}
    </section>
  );
}
