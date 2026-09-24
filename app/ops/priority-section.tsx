"use client";

import { useState } from "react";
import type { OpsPriority, OpsPriorityMode } from "@/lib/ops";

// The markets the pipeline actually works — offered when priority is scoped to one country.
const MARKETS: [string, string][] = [
  ["ZA", "South Africa"], ["KE", "Kenya"], ["NG", "Nigeria"], ["EG", "Egypt"], ["MA", "Morocco"],
  ["GH", "Ghana"], ["TZ", "Tanzania"], ["UG", "Uganda"], ["CI", "Côte d’Ivoire"], ["SN", "Senegal"],
  ["DZ", "Algeria"], ["TN", "Tunisia"], ["ET", "Ethiopia"], ["RW", "Rwanda"], ["ZM", "Zambia"],
  ["ZW", "Zimbabwe"], ["BW", "Botswana"], ["NA", "Namibia"], ["MU", "Mauritius"], ["JP", "Japan"],
];
const NAME = Object.fromEntries(MARKETS);

const MODES: { key: OpsPriorityMode; label: string; blurb: string; tone: string }[] = [
  { key: "balanced", label: "Balanced", blurb: "Normal day-to-day — discovery, liveness and payments share the budget evenly across markets.", tone: "cyan" },
  { key: "import", label: "Enrich imports", blurb: "Prioritise clearing the enrichment backlog on freshly imported chunks (scan → payments → launch).", tone: "mint" },
  { key: "country", label: "Country completeness", blurb: "Push one country toward full coverage before spreading effort back out.", tone: "lilac" },
];
const tonePill: Record<string, string> = {
  cyan: "border-cyan/30 bg-cyan/10 text-cyan", mint: "border-mint/30 bg-mint/10 text-mint", lilac: "border-lilac/30 bg-lilac/10 text-lilac",
};

function ago(iso: string | null): string {
  if (!iso) return "never set";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

export function PrioritySection({ initial }: { initial: OpsPriority }) {
  const [pri, setPri] = useState<OpsPriority>(initial);
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<OpsPriorityMode>(initial.mode);
  const [country, setCountry] = useState<string>(initial.country ?? "ZA");
  const [note, setNote] = useState<string>(initial.note ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const activeTone = MODES.find((m) => m.key === pri.mode)?.tone ?? "cyan";

  async function save() {
    setSaving(true); setErr(null);
    try {
      const res = await fetch("/api/ops/priority", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, country: mode === "country" ? country : null, note }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "save failed");
      setPri(data.priority); setEditing(false);
    } catch (e) { setErr(e instanceof Error ? e.message : "save failed"); }
    finally { setSaving(false); }
  }

  return (
    <section className="mt-5 rounded-3xl border border-cream/12 bg-cream/[0.02] p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-cream/50">Project priority</h2>
        <button onClick={() => { setEditing((v) => !v); setErr(null); }} className="rounded-full border border-cream/15 px-3 py-1 text-xs text-cream/60 hover:text-cream">
          {editing ? "Cancel" : "Adjust"}
        </button>
      </div>

      {/* Current cue */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className={`rounded-full border px-3 py-1 text-sm font-semibold ${tonePill[activeTone]}`}>
          {MODES.find((m) => m.key === pri.mode)?.label ?? pri.mode}
          {pri.mode === "country" && pri.country ? ` · ${NAME[pri.country] ?? pri.country}` : ""}
        </span>
        <span className="text-[11px] text-cream/35">{ago(pri.updatedAt)}{pri.updatedBy ? ` · ${pri.updatedBy}` : ""}</span>
      </div>
      <p className="mt-2 text-[12.5px] leading-relaxed text-cream/55">{MODES.find((m) => m.key === pri.mode)?.blurb}</p>
      {pri.note && <p className="mt-1 text-[12.5px] text-cream/70">“{pri.note}”</p>}

      {/* Editor */}
      {editing && (
        <div className="mt-4 space-y-3 border-t border-cream/10 pt-4">
          <div className="grid gap-2 sm:grid-cols-3">
            {MODES.map((m) => (
              <button key={m.key} onClick={() => setMode(m.key)}
                className={`rounded-2xl border p-3 text-left transition ${mode === m.key ? tonePill[m.tone] : "border-cream/12 bg-cream/[0.02] text-cream/70 hover:bg-cream/[0.04]"}`}>
                <div className="text-sm font-semibold">{m.label}</div>
                <div className="mt-1 text-[11px] leading-snug opacity-80">{m.blurb}</div>
              </button>
            ))}
          </div>

          {mode === "country" && (
            <label className="block text-xs text-cream/50">
              Target country
              <select value={country} onChange={(e) => setCountry(e.target.value)}
                className="mt-1 block w-full rounded-xl border border-cream/15 bg-ink-deep/50 px-3 py-2 text-sm text-cream outline-none focus:border-lilac">
                {MARKETS.map(([c, n]) => <option key={c} value={c}>{n} ({c})</option>)}
              </select>
            </label>
          )}

          <label className="block text-xs text-cream/50">
            Note (optional)
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={280}
              placeholder="e.g. clearing the StoreCensus DE/ME import before anything else"
              className="mt-1 block w-full rounded-xl border border-cream/15 bg-ink-deep/50 px-3 py-2 text-sm text-cream outline-none focus:border-cyan" />
          </label>

          {err && <p className="text-xs text-orange">{err}</p>}
          <div className="flex justify-end">
            <button onClick={save} disabled={saving}
              className="rounded-full bg-cyan px-5 py-2 text-sm font-medium text-cyan-deep transition hover:brightness-110 disabled:opacity-50">
              {saving ? "Saving…" : "Save priority"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
