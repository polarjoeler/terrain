"use client";

import { useState } from "react";
import type { ImportBatch } from "@/lib/ops";

// On-demand so it never slows the 60s auto-refresh: the report only runs when you press "Run".
const WINDOWS = [7, 30, 90];

function ago(iso: string): string {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

function Bar({ label, pct, done, total, tone }: { label: string; pct: number; done: number; total: number; tone: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="uppercase tracking-wide text-cream/45">{label}</span>
        <span className="tabular-nums text-cream/70">{pct}% <span className="text-cream/35">· {done.toLocaleString()}/{total.toLocaleString()}</span></span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-cream/10">
        <div className="h-full rounded-full transition-[width]" style={{ width: `${pct}%`, background: tone }} />
      </div>
    </div>
  );
}

export function ImportsSection() {
  const [days, setDays] = useState(30);
  const [rows, setRows] = useState<ImportBatch[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [computedAt, setComputedAt] = useState<string | null>(null);

  async function run(d = days, fresh = false) {
    setLoading(true); setErr(null);
    try {
      const res = await fetch(`/api/ops/imports?days=${d}${fresh ? "&fresh=1" : ""}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "failed");
      setRows(data.batches); setComputedAt(data.computedAt ?? null);
    } catch (e) { setErr(e instanceof Error ? e.message : "failed"); }
    finally { setLoading(false); }
  }

  return (
    <section className="mt-5 rounded-3xl border border-cream/12 bg-cream/[0.02] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-cream/50">Imports · enrichment progress</h2>
        <div className="flex items-center gap-2">
          <div className="flex overflow-hidden rounded-full border border-cream/15 text-xs">
            {WINDOWS.map((w) => (
              <button key={w} onClick={() => { setDays(w); if (rows) run(w); }}
                className={`px-2.5 py-1 transition ${days === w ? "bg-cream text-ink" : "text-cream/55 hover:text-cream"}`}>{w}d</button>
            ))}
          </div>
          {rows && (
            <button onClick={() => run(days, true)} disabled={loading}
              className="rounded-full border border-cream/15 px-3 py-1 text-xs text-cream/55 hover:text-cream disabled:opacity-50">
              Recompute
            </button>
          )}
          <button onClick={() => run()} disabled={loading}
            className="rounded-full border border-cyan/30 bg-cyan/10 px-3 py-1 text-xs font-medium text-cyan hover:bg-cyan/20 disabled:opacity-50">
            {loading ? "Running…" : rows ? "Reload" : "Run report"}
          </button>
        </div>
      </div>

      {!rows && !err && (
        <p className="mt-3 text-[12.5px] text-cream/40">
          Per-source progress on the three long passes — <span className="text-cream/60">Scan</span>, <span className="text-cream/60">Payments</span>, <span className="text-cream/60">Launch date</span> — for chunks imported in the last {days} days. Run it on demand (it&rsquo;s off the auto-refresh so it never slows this page). The first run takes ~20s, then it&rsquo;s cached.
        </p>
      )}
      {err && <p className="mt-3 text-xs text-orange">Couldn&rsquo;t run: {err}</p>}

      {rows && (
        <>
          <p className="mt-2 text-[11px] text-cream/35">{rows.length} source{rows.length === 1 ? "" : "s"} imported in the last {days}d · computed {computedAt ? ago(computedAt) : "just now"} (cached 30m · Recompute for live)</p>
          <div className="mt-3 space-y-3">
            {rows.length === 0 && <p className="text-sm text-cream/40">No imports in this window.</p>}
            {rows.map((b) => (
              <div key={b.source} className="rounded-2xl border border-cream/10 bg-cream/[0.02] p-3.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-mono text-sm text-cream/85">{b.source}</span>
                  <span className="text-[11px] text-cream/40">
                    {b.total.toLocaleString()} rows · {b.published.toLocaleString()} published · added {ago(b.firstAdd)}
                    {b.firstAdd.slice(0, 10) !== b.lastAdd.slice(0, 10) ? `–${ago(b.lastAdd)}` : ""}
                  </span>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <Bar label="Scan" pct={b.scanPct} done={b.scanned} total={b.total} tone="var(--color-cyan)" />
                  <Bar label="Payments" pct={b.payPct} done={b.paid} total={b.total} tone="var(--color-mint)" />
                  <Bar label="Launch date" pct={b.launchPct} done={b.launched} total={b.total} tone="var(--color-lilac)" />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
