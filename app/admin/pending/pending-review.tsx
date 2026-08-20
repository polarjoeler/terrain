"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { PendingStore } from "@/lib/imported";

const usd = (n: number | null) =>
  n == null ? "—" : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n)}`;

export function PendingReview({ initial }: { initial: PendingStore[] }) {
  const [stores, setStores] = useState(initial);
  const [country, setCountry] = useState<string>("all");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const countries = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of stores) {
      const c = (s.country || "??").toUpperCase();
      m.set(c, (m.get(c) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [stores]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return stores.filter((s) => {
      if (country !== "all" && (s.country || "??").toUpperCase() !== country) return false;
      if (!needle) return true;
      return s.domain.toLowerCase().includes(needle) || (s.name ?? "").toLowerCase().includes(needle);
    });
  }, [stores, country, q]);

  const allShownSelected = rows.length > 0 && rows.every((s) => sel.has(s.domain));
  const toggle = (d: string) =>
    setSel((p) => { const n = new Set(p); n.has(d) ? n.delete(d) : n.add(d); return n; });
  const toggleAll = () =>
    setSel((p) => {
      const n = new Set(p);
      if (allShownSelected) rows.forEach((s) => n.delete(s.domain));
      else rows.forEach((s) => n.add(s.domain));
      return n;
    });

  async function act(action: "publish" | "discard", domains: string[]) {
    if (!domains.length) return;
    const verb = action === "publish" ? "Publish" : "Discard";
    if (action === "discard" && !confirm(`Discard ${domains.length} store(s)? This deletes them.`)) return;
    setBusy(true); setMsg("");
    try {
      const res = await fetch("/api/admin/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, domains }),
      });
      const j = await res.json();
      if (!res.ok) { setMsg(j.error ?? "Failed"); return; }
      const done = new Set(domains);
      setStores((prev) => prev.filter((s) => !done.has(s.domain)));
      setSel((p) => { const n = new Set(p); domains.forEach((d) => n.delete(d)); return n; });
      setMsg(`${verb}ed ${action === "publish" ? j.published : j.discarded} store(s).`);
    } catch { setMsg("Network error"); } finally { setBusy(false); }
  }

  const selectedInView = rows.filter((s) => sel.has(s.domain)).map((s) => s.domain);
  const chip = (active: boolean) =>
    `rounded-full px-3.5 py-1.5 text-sm transition ${active ? "bg-ink text-cream" : "border border-cream/15 text-cream/60 hover:border-cream/40"}`;

  return (
    <div className="mt-8">
      {/* country filter */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-cream/40">Country</span>
        <button onClick={() => setCountry("all")} className={chip(country === "all")}>All ({stores.length})</button>
        {countries.map(([c, n]) => (
          <button key={c} onClick={() => setCountry(c)} className={chip(country === c)}>{c} ({n})</button>
        ))}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search…"
          className="ml-auto rounded-full border border-cream/15 bg-transparent px-4 py-1.5 text-sm text-cream outline-none placeholder:text-cream/35 focus:border-cream/50"
        />
      </div>

      {/* bulk action bar */}
      <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-cream/12 bg-cream/[0.03] px-4 py-3">
        <span className="text-sm text-cream/70">{sel.size} selected</span>
        <button onClick={() => act("publish", [...sel])} disabled={busy || sel.size === 0}
          className="rounded-full bg-mint px-4 py-1.5 text-sm font-medium text-ink hover:brightness-95 disabled:opacity-40">
          Publish selected
        </button>
        <button onClick={() => act("discard", [...sel])} disabled={busy || sel.size === 0}
          className="rounded-full border border-orange/40 px-4 py-1.5 text-sm text-orange hover:border-orange disabled:opacity-40">
          Discard selected
        </button>
        <span className="mx-1 h-4 w-px bg-cream/15" />
        <button onClick={() => act("publish", rows.map((s) => s.domain))} disabled={busy || rows.length === 0}
          className="rounded-full border border-cream/20 px-4 py-1.5 text-sm text-cream/70 hover:border-cream/50 disabled:opacity-40">
          Publish all {country !== "all" ? country : "shown"} ({rows.length})
        </button>
        {msg && <span className="text-xs text-cream/50">{msg}</span>}
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[820px] text-left text-sm text-cream/80">
          <thead className="text-xs uppercase tracking-wide text-cream/40">
            <tr>
              <th className="pb-3 pr-3"><input type="checkbox" checked={allShownSelected} onChange={toggleAll} aria-label="Select all" /></th>
              <th className="pb-3 pr-4">Store</th>
              <th className="pb-3 pr-4">Country</th>
              <th className="pb-3 pr-4">Category</th>
              <th className="pb-3 pr-4">Products</th>
              <th className="pb-3 pr-4">Est. sales</th>
              <th className="pb-3 pr-4">Source</th>
              <th className="pb-3"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.domain} className="border-t border-cream/10 align-middle">
                <td className="py-3 pr-3"><input type="checkbox" checked={sel.has(s.domain)} onChange={() => toggle(s.domain)} aria-label={`Select ${s.domain}`} /></td>
                <td className="py-3 pr-4">
                  <div className="font-medium text-cream">{s.name ?? s.domain}</div>
                  <a href={`https://${s.domain}`} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-cream/45 hover:underline">{s.domain}</a>
                </td>
                <td className="py-3 pr-4 uppercase text-cream/60">{s.country ?? "—"}</td>
                <td className="py-3 pr-4 text-cream/60">{s.category ?? "—"}</td>
                <td className="py-3 pr-4">{s.productCount ?? "—"}</td>
                <td className="py-3 pr-4">{usd(s.estMonthlySales)}</td>
                <td className="py-3 pr-4 text-cream/40">{s.source ?? "—"}</td>
                <td className="py-3 text-right">
                  <div className="flex justify-end gap-2">
                    <Link href={`/admin/leads?domain=${encodeURIComponent(s.domain)}`} className="text-xs text-cream/50 hover:text-cream">edit</Link>
                    <button onClick={() => act("discard", [s.domain])} disabled={busy} className="text-xs text-cream/40 hover:text-orange">drop</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="py-10 text-center text-cream/50">No pending stores match this filter.</p>
        )}
      </div>
    </div>
  );
}
