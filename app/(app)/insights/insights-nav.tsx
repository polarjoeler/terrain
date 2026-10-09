"use client";

import { useState } from "react";
import Link from "next/link";
import { INSIGHTS_CATALOG, TIER_LABEL, type Tier } from "@/lib/insights-catalog";

const BADGE: Record<Tier, { cls: string } | null> = {
  core: null,
  team: { cls: "border-cyan/30 bg-cyan/10 text-cyan" },
  pro: { cls: "border-lilac/30 bg-lilac/10 text-lilac" },
};
function TierBadge({ tier }: { tier: Tier }) {
  const b = BADGE[tier];
  if (!b) return null;
  return <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${b.cls}`}>{TIER_LABEL[tier]}</span>;
}

/** The Insights report library as category dropdowns — discoverable, plan-tagged, and a single place
 *  to reach every report (no more strewn inline links). `active` highlights the current category. */
export function InsightsNav({ active }: { active?: string }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <nav className="flex flex-wrap items-center gap-1" aria-label="Insight categories">
      {INSIGHTS_CATALOG.map((cat) => {
        const isOpen = open === cat.name;
        return (
          <div key={cat.name} className="relative">
            <button onClick={() => setOpen(isOpen ? null : cat.name)} aria-expanded={isOpen}
              className={`flex items-center gap-1 rounded-full px-3.5 py-1.5 text-sm transition ${isOpen || active === cat.name ? "bg-cream/10 text-cream" : "text-cream/65 hover:bg-cream/[0.05] hover:text-cream"}`}>
              {cat.name}<span className={`text-cream/35 transition ${isOpen ? "rotate-180" : ""}`}>▾</span>
            </button>
            {isOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setOpen(null)} />
                <div className="absolute left-0 z-20 mt-2 w-72 rounded-2xl border border-cream/12 bg-ink-deep p-2 shadow-2xl">
                  <div className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-cream/35">{cat.blurb}</div>
                  {cat.reports.map((r) => (
                    r.soon || !r.href ? (
                      <div key={r.title} className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm text-cream/30">
                        <span>{r.title}</span>
                        <span className="rounded-full border border-cream/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-cream/40">Soon</span>
                      </div>
                    ) : (
                      <Link key={r.title} href={r.href} onClick={() => setOpen(null)} className="flex items-start justify-between gap-2 rounded-lg px-3 py-2 transition hover:bg-cream/[0.05]">
                        <span className="min-w-0">
                          <span className="block text-sm text-cream">{r.title}</span>
                          <span className="block text-xs leading-snug text-cream/45">{r.desc}</span>
                        </span>
                        <TierBadge tier={r.tier} />
                      </Link>
                    )
                  ))}
                </div>
              </>
            )}
          </div>
        );
      })}
    </nav>
  );
}
