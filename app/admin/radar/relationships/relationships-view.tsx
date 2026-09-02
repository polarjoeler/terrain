"use client";

import { useState } from "react";
import type { Relationship, RelationshipLabel } from "@/lib/radar/relationships";

const LABELS: { key: RelationshipLabel; text: string; tone: string }[] = [
  { key: "fraud", text: "Fraud", tone: "border-orange/40 text-orange hover:bg-orange/10" },
  { key: "commerce", text: "Commerce", tone: "border-mint/40 text-mint hover:bg-mint/10" },
  { key: "same-owner", text: "Same owner", tone: "border-cream/25 text-cream/70 hover:bg-cream/10" },
];
const ACTIVE: Record<RelationshipLabel, string> = {
  fraud: "bg-orange text-ink border-orange",
  commerce: "bg-mint text-ink border-mint",
  "same-owner": "bg-cream text-ink border-cream",
};

export function RelationshipsView({ rows }: { rows: Relationship[] }) {
  const [labels, setLabels] = useState<Record<string, RelationshipLabel | null>>(
    Object.fromEntries(rows.map((r) => [`${r.brandDomain}|${r.suspect}`, r.label])),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = async (r: Relationship, label: RelationshipLabel) => {
    const key = `${r.brandDomain}|${r.suspect}`;
    const next = labels[key] === label ? null : label; // clicking the active label clears it
    setBusy(key);
    setError(null);
    const prev = labels[key];
    setLabels((m) => ({ ...m, [key]: next }));   // optimistic
    try {
      const res = await fetch("/api/admin/radar/label", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ victim: r.brandDomain, suspect: r.suspect, label: next }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    } catch (e) {
      setLabels((m) => ({ ...m, [key]: prev }));  // roll back so the UI never lies about what was saved
      setError(e instanceof Error ? e.message : "could not save label");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {error && <p className="mt-4 rounded-2xl border border-orange/30 bg-orange/10 px-4 py-3 text-sm text-orange">{error}</p>}
      <div className="mt-4 space-y-3">
        {rows.map((r) => {
          const key = `${r.brandDomain}|${r.suspect}`;
          const current = labels[key];
          return (
            <div key={key} className={`rounded-2xl border p-5 ${current ? "border-cream/20 bg-cream/[0.03]" : "border-cream/12"}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-mono text-sm text-cream">
                    {r.suspect} <span className="text-cream/35">shares a catalogue with</span> {r.brandDomain}
                  </div>
                  <div className="mt-1 text-xs text-cream/45">{r.detail}</div>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-cream/40">
                    <span>overlap <b className="text-cream/70">{r.overlap ?? "—"}</b></span>
                    <span>impersonation <b className="text-cream/70">{r.impersonation ?? "—"}</b></span>
                    <span>{r.shared ?? 0} shared images</span>
                    <span>{r.exclusive ?? 0} on no other store</span>
                    <span className="rounded-full border border-cream/15 px-2">{r.reason}</span>
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  {LABELS.map((l) => (
                    <button
                      key={l.key}
                      disabled={busy === key}
                      onClick={() => apply(r, l.key)}
                      className={`rounded-full border px-3 py-1 text-xs font-medium transition disabled:opacity-40 ${
                        current === l.key ? ACTIVE[l.key] : l.tone
                      }`}
                    >
                      {l.text}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mt-3 flex gap-3 text-xs">
                <a href={`https://${r.suspect}`} target="_blank" rel="noopener noreferrer" className="text-cyan hover:underline">open {r.suspect} ↗</a>
                <a href={`https://${r.brandDomain}`} target="_blank" rel="noopener noreferrer" className="text-cream/45 hover:text-cream">open {r.brandDomain} ↗</a>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
