"use client";

import { useCallback, useEffect, useState } from "react";

type Coverage = {
  universe: number;
  fingerprinted: number;
  remaining: number;
  withCatalogue: number;
};

export function EnrichPanel() {
  const [cov, setCov] = useState<Coverage | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/enrich");
      const data = await res.json();
      if (res.ok) setCov(data.coverage);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function run() {
    setRunning(true);
    setErr(null);
    try {
      // Loop batches until the universe is fully fingerprinted.
      for (let guard = 0; guard < 1000; guard++) {
        const res = await fetch("/api/admin/enrich", { method: "POST" });
        const data = await res.json();
        if (!res.ok) {
          setErr(data.error || "Enrichment failed");
          break;
        }
        setCov(data.coverage);
        if (data.processed === 0 || data.coverage.remaining === 0) break;
      }
    } catch {
      setErr("Network error during enrichment");
    } finally {
      setRunning(false);
    }
  }

  const pct = cov && cov.universe ? Math.round((cov.fingerprinted / cov.universe) * 100) : 0;

  return (
    <section className="mt-12 rounded-3xl border border-cream/12 p-6 md:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl">Radar — store fingerprints</h2>
          <p className="mt-1 max-w-md text-sm text-cream/55">
            Fingerprint the South African store universe so Brand Audits scan
            against it instantly. Run this after importing new stores.
          </p>
        </div>
        <button
          onClick={run}
          disabled={running}
          className="shrink-0 rounded-full bg-cyan px-5 py-2.5 text-sm font-medium text-cyan-deep transition hover:brightness-110 disabled:opacity-60"
        >
          {running ? "Fingerprinting…" : "Fingerprint stores"}
        </button>
      </div>

      {cov && (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ["Universe", cov.universe],
              ["Fingerprinted", cov.fingerprinted],
              ["With catalogue", cov.withCatalogue],
              ["Remaining", cov.remaining],
            ].map(([label, n]) => (
              <div key={label} className="rounded-2xl border border-cream/12 p-4">
                <div className="font-display text-3xl text-cyan">
                  {(n as number).toLocaleString()}
                </div>
                <div className="mt-1 text-xs uppercase tracking-wide text-cream/45">
                  {label}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-5">
            <div className="h-2 overflow-hidden rounded-full bg-cream/10">
              <div
                className="h-full rounded-full bg-cyan transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="mt-2 text-xs text-cream/45">
              {pct}% of the universe fingerprinted
              {running && " · working…"}
            </div>
          </div>
        </>
      )}
      {err && <p className="mt-4 text-sm text-orange">{err}</p>}
    </section>
  );
}
