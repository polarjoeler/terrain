"use client";

import { useMemo, useState } from "react";
import { InteractiveBars, CountUp } from "@/app/components/interactive-bars";
import type { ChurnReport, ChurnedStore } from "@/lib/churn";

const usd = (n: number | null) =>
  n == null ? "—" : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n)}`;
const ago = (iso: string) => {
  const d = (Date.now() - new Date(iso).getTime()) / 864e5;
  if (d < 1) return "today";
  if (d < 2) return "yesterday";
  if (d < 30) return `${Math.floor(d)}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};

type Dim = "platform" | "category" | "payment" | "shipping" | "city" | "theme";
type Filter = { dim: Dim; value: string };
const DIM_LABEL: Record<Dim, string> = {
  platform: "Migrated to", category: "Category", payment: "Payment", shipping: "Shipping", city: "City", theme: "Theme",
};

const hasTok = (field: string | null, value: string) =>
  (field ?? "").split(";").map((s) => s.trim()).includes(value);

function matches(r: ChurnedStore, f: Filter): boolean {
  switch (f.dim) {
    case "platform": return r.migratedTo === f.value;
    case "category": return r.category === f.value;
    case "city": return r.city === f.value;
    case "theme": return r.theme === f.value;
    case "payment": return hasTok(r.payments, f.value);
    case "shipping": return hasTok(r.shipping, f.value);
  }
}

export function ChurnView({ report: r }: { report: ChurnReport }) {
  const [filter, setFilter] = useState<Filter | null>(null);

  const select = (dim: Dim) => (value: string) =>
    setFilter((cur) => (cur && cur.dim === dim && cur.value === value ? null : { dim, value }));
  const activeFor = (dim: Dim) => (filter && filter.dim === dim ? filter.value : null);

  const recent = useMemo(() => (filter ? r.recent.filter((c) => matches(c, filter)) : r.recent), [r.recent, filter]);

  const cards: { title: string; subtitle?: string; dim: Dim; data: typeof r.byPlatform; tone: string }[] = [
    { title: "Migrated to", subtitle: `Where ${r.migrated.toLocaleString()} stores went`, dim: "platform", data: r.byPlatform, tone: "cyan" },
    { title: "Categories", subtitle: "What churned stores sold", dim: "category", data: r.byCategory, tone: "orange" },
    { title: "Payments they used", subtitle: "Checkout-verified, where known", dim: "payment", data: r.byPayment, tone: "mint" },
    { title: "Shipping they used", subtitle: "Where known", dim: "shipping", data: r.byShipping, tone: "lilac" },
    { title: "Cities", dim: "city", data: r.byCity, tone: "orange" },
    { title: "Themes", dim: "theme", data: r.byTheme, tone: "mint" },
  ];

  const tiles = [
    { n: r.total, l: "total churned" },
    { n: r.dead, l: "dead" },
    { n: r.migrated, l: "migrated off Shopify" },
    { n: r.last30, l: "in last 30 days" },
    { n: r.last90, l: "in last 90 days" },
  ];

  return (
    <>
      <div className="mt-8 grid gap-4 sm:grid-cols-3 md:grid-cols-5">
        {tiles.map((t) => (
          <div key={t.l} className="rounded-3xl border border-cream/12 px-5 py-5">
            <CountUp value={t.n} className="font-display text-3xl text-cream" />
            <div className="mt-1 text-xs font-semibold uppercase tracking-wide text-cream/45">{t.l}</div>
          </div>
        ))}
      </div>

      <div className="mt-6 grid gap-5 md:grid-cols-2">
        {cards.map((c) => (
          <div key={c.title} className="rounded-[2rem] border border-cream/12 bg-cream/[0.03] p-6">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-lg font-semibold text-cream">{c.title}</h3>
              {activeFor(c.dim) && (
                <button onClick={() => setFilter(null)} className="text-xs text-cyan hover:underline">clear</button>
              )}
            </div>
            {c.subtitle && <p className="mt-1 text-xs text-cream/45">{c.subtitle}</p>}
            <p className="mt-1 text-[11px] text-cream/30">Click a bar to filter the store list below.</p>
            <div className="mt-4">
              <InteractiveBars data={c.data} tone={c.tone} activeLabel={activeFor(c.dim)} onSelect={select(c.dim)} />
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 rounded-[2rem] border border-cream/12 bg-cream/[0.03] p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-lg font-semibold text-cream">Recently churned</h3>
          {filter ? (
            <button
              onClick={() => setFilter(null)}
              className="inline-flex items-center gap-2 rounded-full bg-cyan/15 px-3 py-1 text-xs font-medium text-cyan transition hover:bg-cyan/25"
            >
              {DIM_LABEL[filter.dim]}: {filter.value}
              <span className="text-sm leading-none">✕</span>
            </button>
          ) : (
            <span className="text-xs text-cream/35">Showing latest {r.recent.length}</span>
          )}
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm text-cream/80">
            <thead className="text-xs uppercase tracking-wide text-cream/40">
              <tr>
                <th className="pb-3 pr-4">Store</th>
                <th className="pb-3 pr-4">Status</th>
                <th className="pb-3 pr-4">Churned</th>
                <th className="pb-3 pr-4">Category</th>
                <th className="pb-3 pr-4">Est. sales</th>
                <th className="pb-3">Was using</th>
              </tr>
            </thead>
            <tbody>
              {recent.length === 0 && (
                <tr><td colSpan={6} className="py-6 text-center text-cream/40">No stores in the latest {r.recent.length} match this filter.</td></tr>
              )}
              {recent.map((c) => (
                <tr key={c.domain} className="border-t border-cream/10 align-top">
                  <td className="py-3 pr-4">
                    <div className="font-medium text-cream">{c.name ?? c.domain}</div>
                    <span className="font-mono text-xs text-cream/40">{c.domain}</span>
                  </td>
                  <td className="py-3 pr-4">
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${c.status === "migrated" ? "bg-cyan/15 text-cyan" : "bg-orange/15 text-orange"}`}>
                      {c.status === "migrated" ? `→ ${c.migratedTo ?? "other"}` : "dead"}
                    </span>
                  </td>
                  <td className="py-3 pr-4 whitespace-nowrap text-cream/55">{ago(c.churnedAt)}</td>
                  <td className="py-3 pr-4 text-cream/60">{c.category ?? "—"}</td>
                  <td className="py-3 pr-4 whitespace-nowrap">{usd(c.estMonthlySales)}</td>
                  <td className="py-3 text-xs text-cream/55">{[c.payments, c.shipping].filter(Boolean).join(" · ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
