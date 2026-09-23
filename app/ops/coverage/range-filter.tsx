"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

const iso = (d: Date) => d.toISOString().slice(0, 10);
/* eslint-disable react-hooks/purity -- a date picker legitimately seeds its default range from "today" */
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 864e5));

export function RangeFilter({ countries }: { countries: { code: string; name: string; emoji: string }[] }) {
  const router = useRouter();
  const sp = useSearchParams();
  const [from, setFrom] = useState(sp.get("from") ?? daysAgo(30));
  const [to, setTo] = useState(sp.get("to") ?? daysAgo(0));
  const [ac, setAc] = useState(sp.get("ac") ?? "");

  const go = (f: string, t: string, c: string) => {
    const p = new URLSearchParams(Array.from(sp.entries()));
    p.set("from", f); p.set("to", t);
    if (c) p.set("ac", c); else p.delete("ac");
    router.push(`?${p.toString()}#activity`);
  };
  const preset = (days: number) => { const f = daysAgo(days), t = daysAgo(0); setFrom(f); setTo(t); go(f, t, ac); };
  /* eslint-enable react-hooks/purity */

  const field = "rounded-lg border border-cream/15 bg-ink-deep/40 px-3 py-1.5 text-sm text-cream outline-none focus:border-cyan";
  return (
    <div className="flex flex-wrap items-end gap-2.5">
      <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-cream/40">From
        <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className={field} /></label>
      <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-cream/40">To
        <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className={field} /></label>
      <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-cream/40">Country
        <select value={ac} onChange={(e) => { setAc(e.target.value); go(from, to, e.target.value); }} className={field}>
          <option value="" className="text-ink">All countries</option>
          {countries.map((c) => <option key={c.code} value={c.code} className="text-ink">{c.emoji} {c.name}</option>)}
        </select></label>
      <button onClick={() => go(from, to, ac)} className="rounded-lg bg-cyan px-4 py-1.5 text-sm font-medium text-cyan-deep transition hover:brightness-110">Apply</button>
      <div className="flex gap-1">
        {[["7d", 7], ["30d", 30], ["90d", 90], ["1y", 365]].map(([l, d]) => (
          <button key={l as string} onClick={() => preset(d as number)} className="rounded-full border border-cream/15 px-2.5 py-1 text-[11px] text-cream/55 hover:text-cream">{l}</button>
        ))}
      </div>
    </div>
  );
}
