"use client";

import { useMemo, useState } from "react";
import { marketLabel } from "@/lib/markets";
import { revenueBand, bandTone, scoreColor, REVENUE_BANDS, type RevenueBand } from "@/lib/revenue";
import type { ExploreLead } from "@/lib/leads-explore";

const PAGE = 60;
type SortKey = "score" | "sales" | "name";

const usd = (n: number | null) =>
  n == null ? "—" : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n)}`;

function ScoreRing({ score }: { score: number }) {
  const c = scoreColor(score);
  const r = 13, circ = 2 * Math.PI * r;
  return (
    <div className="relative h-8 w-8">
      <svg viewBox="0 0 32 32" className="h-8 w-8 -rotate-90">
        <circle cx="16" cy="16" r={r} fill="none" stroke="var(--color-cream)" strokeOpacity="0.12" strokeWidth="3" />
        <circle cx="16" cy="16" r={r} fill="none" stroke={c} strokeWidth="3" strokeLinecap="round"
          strokeDasharray={circ} strokeDashoffset={circ * (1 - score / 100)} />
      </svg>
      <span className="absolute inset-0 grid place-items-center text-[11px] font-semibold tabular-nums" style={{ color: c }}>{score}</span>
    </div>
  );
}

function Facet({ title, values, selected, onToggle }: { title: string; values: [string, number][]; selected: Set<string>; onToggle: (v: string) => void }) {
  const [open, setOpen] = useState(true);
  const [expand, setExpand] = useState(false);
  const shown = expand ? values : values.slice(0, 6);
  return (
    <div className="border-b border-cream/10 py-3">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wide text-cream/50">
        {title}<span className="text-cream/30">{open ? "–" : "+"}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-1">
          {shown.map(([v, n]) => (
            <button key={v} onClick={() => onToggle(v)}
              className={`flex w-full items-center justify-between rounded-lg px-2 py-1 text-left text-sm transition ${selected.has(v) ? "bg-cyan/15 text-cream" : "text-cream/70 hover:bg-cream/[0.05]"}`}>
              <span className="flex items-center gap-1.5 truncate">
                <span className={`h-3 w-3 shrink-0 rounded border ${selected.has(v) ? "border-cyan bg-cyan" : "border-cream/25"}`} />
                <span className="truncate">{title === "Country" ? marketLabel(v) : v}</span>
              </span>
              <span className="ml-2 shrink-0 text-xs tabular-nums text-cream/35">{n.toLocaleString()}</span>
            </button>
          ))}
          {values.length > 6 && (
            <button onClick={() => setExpand((e) => !e)} className="px-2 text-xs text-cream/45 hover:text-cream">
              {expand ? "Show less" : `+${values.length - 6} more`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function Explorer({ leads }: { leads: ExploreLead[] }) {
  const [q, setQ] = useState("");
  const [country, setCountry] = useState<Set<string>>(new Set());
  const [category, setCategory] = useState<Set<string>>(new Set());
  const [band, setBand] = useState<Set<string>>(new Set());
  const [theme, setTheme] = useState<Set<string>>(new Set());
  const [city, setCity] = useState<Set<string>>(new Set());
  const [payment, setPayment] = useState<Set<string>>(new Set());
  const [plusOnly, setPlusOnly] = useState(false);
  const [emailOnly, setEmailOnly] = useState(false);
  const [sort, setSort] = useState<SortKey>("score");
  const [shown, setShown] = useState(PAGE);

  const toggle = (set: React.Dispatch<React.SetStateAction<Set<string>>>) => (v: string) =>
    set((prev) => { const n = new Set(prev); n.has(v) ? n.delete(v) : n.add(v); return n; });

  // Faceted matcher — `skip` lets a facet's own counts ignore its own selection.
  const passes = (l: ExploreLead, skip?: string) => {
    if (skip !== "q" && q) {
      const needle = q.toLowerCase();
      if (!l.domain.toLowerCase().includes(needle) && !(l.name ?? "").toLowerCase().includes(needle)) return false;
    }
    if (skip !== "country" && country.size && !country.has((l.country ?? "??").toUpperCase())) return false;
    if (skip !== "category" && category.size && !category.has(l.category ?? "—")) return false;
    if (skip !== "band" && band.size && !band.has(revenueBand(l.estMonthlySales))) return false;
    if (skip !== "theme" && theme.size && !theme.has(l.theme ?? "—")) return false;
    if (skip !== "city" && city.size && !city.has(l.city ?? "—")) return false;
    if (skip !== "payment" && payment.size) {
      const toks = (l.payments ?? "").split(";").map((t) => t.trim());
      if (![...payment].some((p) => toks.includes(p))) return false;
    }
    if (plusOnly && !l.plus) return false;
    if (emailOnly && !l.email) return false;
    return true;
  };

  const filtered = useMemo(() => {
    const out = leads.filter((l) => passes(l));
    out.sort((a, b) =>
      sort === "sales" ? (b.estMonthlySales ?? 0) - (a.estMonthlySales ?? 0)
      : sort === "name" ? (a.name ?? a.domain).localeCompare(b.name ?? b.domain)
      : b.score - a.score);
    return out;
  }, [leads, q, country, category, band, theme, city, payment, plusOnly, emailOnly, sort]);

  const countBy = (skip: string, key: (l: ExploreLead) => string): [string, number][] => {
    const m = new Map<string, number>();
    for (const l of leads) if (passes(l, skip)) { const k = key(l); m.set(k, (m.get(k) ?? 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  // All facet counts recompute together whenever any filter changes.
  const facets = useMemo(() => {
    const order = new Map(REVENUE_BANDS.map((b, i) => [b as string, i]));
    const paymentCounts = new Map<string, number>();
    for (const l of leads) if (passes(l, "payment"))
      for (const t of (l.payments ?? "").split(";").map((x) => x.trim()).filter(Boolean)) paymentCounts.set(t, (paymentCounts.get(t) ?? 0) + 1);
    return {
      country: countBy("country", (l) => (l.country ?? "??").toUpperCase()),
      category: countBy("category", (l) => l.category ?? "—").filter(([c]) => c !== "—"),
      band: countBy("band", (l) => revenueBand(l.estMonthlySales)).filter(([b]) => b !== "—").sort((a, b) => (order.get(a[0]) ?? 9) - (order.get(b[0]) ?? 9)),
      theme: countBy("theme", (l) => l.theme ?? "—").filter(([t]) => t !== "—"),
      city: countBy("city", (l) => l.city ?? "—").filter(([c]) => c !== "—"),
      payment: [...paymentCounts.entries()].sort((a, b) => b[1] - a[1]),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leads, q, country, category, band, theme, city, payment, plusOnly, emailOnly]);

  const clearAll = () => { setQ(""); setCountry(new Set()); setCategory(new Set()); setBand(new Set()); setTheme(new Set()); setCity(new Set()); setPayment(new Set()); setPlusOnly(false); setEmailOnly(false); };
  const activeCount = country.size + category.size + band.size + theme.size + city.size + payment.size + (plusOnly ? 1 : 0) + (emailOnly ? 1 : 0) + (q ? 1 : 0);

  const exportCsv = () => {
    const head = ["domain", "name", "category", "country", "city", "est_monthly_sales", "revenue_band", "lead_score", "plus", "email", "instagram", "facebook", "tiktok"];
    const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const rows = filtered.map((l) => [l.domain, l.name, l.category, l.country, l.city, l.estMonthlySales, revenueBand(l.estMonthlySales), l.score, l.plus, l.email, l.instagram, l.facebook, l.tiktok].map(esc).join(","));
    const blob = new Blob([[head.join(","), ...rows].join("\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `terrain-leads-${filtered.length}.csv`; a.click();
  };

  return (
    <div className="flex min-h-screen gap-0">
      {/* filter rail */}
      <aside className="w-64 shrink-0 border-r border-cream/10 px-4 py-5">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-cream">Filters {activeCount > 0 && <span className="ml-1 rounded-full bg-cyan/20 px-1.5 text-xs text-cyan">{activeCount}</span>}</span>
          {activeCount > 0 && <button onClick={clearAll} className="text-xs text-cream/45 hover:text-cream">Clear all</button>}
        </div>
        <div className="mt-3 space-y-1">
          <button onClick={() => setPlusOnly((p) => !p)} className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${plusOnly ? "bg-lilac/20 text-cream" : "text-cream/70 hover:bg-cream/[0.05]"}`}>
            <span className={`h-3 w-3 rounded border ${plusOnly ? "border-lilac bg-lilac" : "border-cream/25"}`} /> Shopify Plus only
          </button>
          <button onClick={() => setEmailOnly((p) => !p)} className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${emailOnly ? "bg-mint/20 text-cream" : "text-cream/70 hover:bg-cream/[0.05]"}`}>
            <span className={`h-3 w-3 rounded border ${emailOnly ? "border-mint bg-mint" : "border-cream/25"}`} /> Has email
          </button>
        </div>
        <Facet title="Country" values={facets.country} selected={country} onToggle={toggle(setCountry)} />
        <Facet title="Revenue" values={facets.band} selected={band} onToggle={toggle(setBand)} />
        <Facet title="Category" values={facets.category} selected={category} onToggle={toggle(setCategory)} />
        <Facet title="Theme" values={facets.theme} selected={theme} onToggle={toggle(setTheme)} />
        <Facet title="Payment" values={facets.payment} selected={payment} onToggle={toggle(setPayment)} />
        <Facet title="City" values={facets.city} selected={city} onToggle={toggle(setCity)} />
      </aside>

      {/* main */}
      <main className="min-w-0 flex-1 px-5 py-5">
        <div className="flex flex-wrap items-center gap-3">
          <input value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE); }} placeholder="Search domain or store…"
            className="w-72 rounded-full border border-cream/15 bg-transparent px-4 py-2 text-sm text-cream outline-none placeholder:text-cream/35 focus:border-cream/50" />
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="rounded-full border border-cream/15 bg-transparent px-3 py-2 text-sm text-cream outline-none">
            <option value="score" className="text-ink">Sort: Lead Fit Score</option>
            <option value="sales" className="text-ink">Sort: Revenue</option>
            <option value="name" className="text-ink">Sort: Name</option>
          </select>
          <span className="text-sm text-cream/50"><b className="text-cream">{filtered.length.toLocaleString()}</b> of {leads.length.toLocaleString()} leads</span>
          <button onClick={exportCsv} className="ml-auto rounded-full bg-mint px-4 py-2 text-sm font-medium text-ink transition hover:brightness-105">Export {filtered.length.toLocaleString()} → CSV</button>
        </div>

        <div className="mt-4 overflow-x-auto rounded-2xl border border-cream/10">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead className="border-b border-cream/10 text-xs uppercase tracking-wide text-cream/40">
              <tr>
                <th className="px-4 py-3">Store</th><th className="px-4 py-3">Category</th><th className="px-4 py-3">Market</th>
                <th className="px-4 py-3">Revenue</th><th className="px-4 py-3">Fit</th><th className="px-4 py-3">Contacts</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, shown).map((l) => {
                const b = revenueBand(l.estMonthlySales);
                return (
                  <tr key={l.domain} className="border-t border-cream/[0.07] transition hover:bg-cream/[0.03]">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <img src={`https://www.google.com/s2/favicons?sz=64&domain=${l.domain}`} alt="" width={24} height={24} className="h-6 w-6 shrink-0 rounded bg-cream/10 object-contain" loading="lazy" />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 font-medium text-cream">{l.name ?? l.domain}{l.plus && <span className="rounded bg-lilac/20 px-1 py-0.5 text-[8px] font-bold text-lilac">PLUS</span>}</div>
                          <a href={`https://${l.domain}`} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-cream/40 hover:underline">{l.domain}</a>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-cream/60">{l.category ?? "—"}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-cream/70">{l.country ? marketLabel(l.country) : "—"}</td>
                    <td className="px-4 py-2.5"><span className={`whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${bandTone(b)}`}>{b}</span> <span className="ml-1 text-xs text-cream/30">{usd(l.estMonthlySales)}</span></td>
                    <td className="px-4 py-2.5"><ScoreRing score={l.score} /></td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2 text-xs">
                        {l.email ? <a href={`mailto:${l.email}`} className="text-cyan hover:underline">✉ {l.email.length > 22 ? l.email.slice(0, 22) + "…" : l.email}</a> : <span className="text-cream/25">no email</span>}
                        {l.instagram && <a href={`https://instagram.com/${l.instagram.replace(/^@/, "")}`} target="_blank" rel="noopener noreferrer" className="text-cream/40 hover:text-cream">IG</a>}
                        {l.facebook && <span className="text-cream/40">FB</span>}
                        {l.tiktok && <span className="text-cream/40">TT</span>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {shown < filtered.length && (
          <div className="mt-4 text-center">
            <button onClick={() => setShown((s) => s + PAGE)} className="rounded-full border border-cream/15 px-5 py-2 text-sm text-cream/70 hover:border-cream/40">
              Load more ({(filtered.length - shown).toLocaleString()} left)
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
