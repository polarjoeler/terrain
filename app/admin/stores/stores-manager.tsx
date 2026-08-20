"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { PRESET_TAGS, tagLabel } from "@/lib/tag-defs";
import { marketLabel } from "@/lib/markets";

type Row = { domain: string; name: string | null; country: string | null; estMonthlySales: number | null; plus: boolean; tags: string[] };
const PAGE = 50;
const usd = (n: number | null) =>
  n == null ? "—" : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n)}`;

export function StoresManager({ initial, countries }: { initial: Row[]; countries: { country: string; stores: number }[] }) {
  const [rows, setRows] = useState(initial);
  const [q, setQ] = useState("");
  const [country, setCountry] = useState("all");
  const [tagFilter, setTagFilter] = useState("all"); // all | <tag> | untagged
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState(PAGE);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (country !== "all" && (r.country || "").toUpperCase() !== country) return false;
      if (tagFilter === "untagged" && r.tags.length) return false;
      if (tagFilter !== "all" && tagFilter !== "untagged" && !r.tags.includes(tagFilter)) return false;
      if (!needle) return true;
      return r.domain.toLowerCase().includes(needle) || (r.name ?? "").toLowerCase().includes(needle);
    });
  }, [rows, q, country, tagFilter]);

  const page = filtered.slice(0, shown);
  const reset = () => setShown(PAGE);

  async function apply(domains: string[], tag: string, on: boolean) {
    if (!domains.length) return;
    setBusy(true); setMsg("");
    try {
      const res = await fetch("/api/admin/tags", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domains, tag, on }),
      });
      const j = await res.json();
      if (!res.ok) { setMsg(j.error ?? "Failed"); return; }
      const set = new Set(domains);
      setRows((prev) => prev.map((r) => {
        if (!set.has(r.domain)) return r;
        const has = r.tags.includes(tag);
        if (on && !has) return { ...r, tags: [...r.tags, tag] };
        if (!on && has) return { ...r, tags: r.tags.filter((t) => t !== tag) };
        return r;
      }));
      setMsg(`${on ? "Tagged" : "Untagged"} ${j.affected} store(s) · ${tagLabel(tag)}`);
    } finally { setBusy(false); }
  }

  const toggleSel = (d: string) => setSel((p) => { const n = new Set(p); n.has(d) ? n.delete(d) : n.add(d); return n; });
  const allPageSel = page.length > 0 && page.every((r) => sel.has(r.domain));
  const toggleAll = () => setSel((p) => { const n = new Set(p); if (allPageSel) page.forEach((r) => n.delete(r.domain)); else page.forEach((r) => n.add(r.domain)); return n; });

  const chip = (active: boolean) => `rounded-full px-3 py-1 text-xs transition ${active ? "bg-ink text-cream" : "border border-ink/15 text-ink/60 hover:border-ink/40"}`;

  return (
    <div className="mt-8 rounded-[2rem] bg-paper p-6 text-ink md:p-8">
      {/* filters */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-ink/40">Show</span>
        <button onClick={() => { setTagFilter("all"); reset(); }} className={chip(tagFilter === "all")}>All ({rows.length})</button>
        {PRESET_TAGS.map((t) => (
          <button key={t.key} onClick={() => { setTagFilter(t.key); reset(); }} className={chip(tagFilter === t.key)}>
            {t.label} ({rows.filter((r) => r.tags.includes(t.key)).length})
          </button>
        ))}
        <button onClick={() => { setTagFilter("untagged"); reset(); }} className={chip(tagFilter === "untagged")}>Untagged</button>
        {countries.length > 1 && (
          <select value={country} onChange={(e) => { setCountry(e.target.value); reset(); }}
            className="ml-2 rounded-full border border-ink/15 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-ink/50">
            <option value="all">All markets</option>
            {countries.map((c) => <option key={c.country} value={c.country}>{marketLabel(c.country)}</option>)}
          </select>
        )}
        <input value={q} onChange={(e) => { setQ(e.target.value); reset(); }} placeholder="Search…"
          className="ml-auto rounded-full border border-ink/15 bg-transparent px-4 py-1.5 text-sm outline-none placeholder:text-ink/35 focus:border-ink/50" />
      </div>

      {/* bulk bar */}
      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-2xl bg-ink/[0.04] px-4 py-3">
        <span className="text-sm font-medium">{sel.size} selected</span>
        {PRESET_TAGS.map((t) => (
          <button key={t.key} onClick={() => apply([...sel], t.key, true)} disabled={busy || sel.size === 0}
            className="rounded-full bg-ink px-3 py-1.5 text-xs font-medium text-cream disabled:opacity-40">
            + {t.label}
          </button>
        ))}
        {tagFilter !== "all" && tagFilter !== "untagged" && (
          <button onClick={() => apply([...sel], tagFilter, false)} disabled={busy || sel.size === 0}
            className="rounded-full border border-orange/40 px-3 py-1.5 text-xs text-orange disabled:opacity-40">
            − Remove {tagLabel(tagFilter)}
          </button>
        )}
        {msg && <span className="text-xs text-ink/50">{msg}</span>}
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-ink/40">
            <tr>
              <th className="pb-3 pr-3"><input type="checkbox" checked={allPageSel} onChange={toggleAll} aria-label="Select all" /></th>
              <th className="pb-3 pr-4">Store</th>
              <th className="pb-3 pr-4">Market</th>
              <th className="pb-3 pr-4">Est. sales</th>
              <th className="pb-3 pr-4">Tags</th>
              <th className="pb-3"></th>
            </tr>
          </thead>
          <tbody>
            {page.map((r) => (
              <tr key={r.domain} className="border-t border-ink/10 align-middle">
                <td className="py-3 pr-3"><input type="checkbox" checked={sel.has(r.domain)} onChange={() => toggleSel(r.domain)} aria-label={`Select ${r.domain}`} /></td>
                <td className="py-3 pr-4">
                  <div className="font-medium">{r.name ?? r.domain}{r.plus && <span className="ml-1.5 rounded-full bg-lilac px-1.5 py-0.5 text-[9px] font-bold align-middle">PLUS</span>}</div>
                  <a href={`https://${r.domain}`} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-ink/45 hover:underline">{r.domain}</a>
                </td>
                <td className="py-3 pr-4 whitespace-nowrap text-ink/60">{r.country ? marketLabel(r.country) : "—"}</td>
                <td className="py-3 pr-4 whitespace-nowrap font-medium">{usd(r.estMonthlySales)}</td>
                <td className="py-3 pr-4">
                  <div className="flex flex-wrap gap-1">
                    {PRESET_TAGS.map((t) => {
                      const on = r.tags.includes(t.key);
                      return (
                        <button key={t.key} onClick={() => apply([r.domain], t.key, !on)} disabled={busy}
                          className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition ${on ? "bg-mint text-ink" : "border border-ink/15 text-ink/40 hover:border-ink/40"}`}>
                          {on ? "✓ " : "+ "}{t.label}
                        </button>
                      );
                    })}
                  </div>
                </td>
                <td className="py-3 text-right">
                  <Link href={`/admin/leads?domain=${encodeURIComponent(r.domain)}`} className="text-xs text-ink/50 hover:text-ink">edit →</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <p className="py-10 text-center text-ink/50">No stores match.</p>}
      </div>

      {shown < filtered.length && (
        <button onClick={() => setShown((s) => s + PAGE)} className="mt-6 w-full rounded-full border border-ink/15 py-3 text-sm font-medium text-ink/70 hover:border-ink/40">
          Show {Math.min(PAGE, filtered.length - shown)} more ({filtered.length.toLocaleString()} match)
        </button>
      )}
    </div>
  );
}
