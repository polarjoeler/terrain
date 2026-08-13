"use client";

import { useMemo, useState } from "react";
import type { Lead } from "@/lib/leads";
import {
  isNewLaunch,
  marketOf,
  sortLeads,
  type Market,
  type SortKey,
} from "@/lib/prioritize";

type Quality = "all" | "email" | "plus" | "payments" | "new";

const qualityFilters: { key: Quality; label: string }[] = [
  { key: "all", label: "All" },
  { key: "new", label: "New launches" },
  { key: "email", label: "With email" },
  { key: "plus", label: "Plus only" },
  { key: "payments", label: "Payments known" },
];

const markets: { key: Market | "all"; label: string }[] = [
  { key: "all", label: "All markets" },
  { key: "South Africa", label: "South Africa" },
  { key: "Africa", label: "Africa" },
  { key: "Japan", label: "Japan" },
];

const sorts: { key: SortKey; label: string }[] = [
  { key: "priority", label: "Priority" },
  { key: "newest", label: "Newest seen" },
  { key: "launched", label: "Newest launched" },
];

const PAGE = 25;

export function LeadsTable({ leads }: { leads: Lead[] }) {
  const [quality, setQuality] = useState<Quality>("all");
  const [market, setMarket] = useState<Market | "all">("all");
  const [sort, setSort] = useState<SortKey>("priority");
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(PAGE);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = leads.filter((l) => {
      if (quality === "email" && !l.email) return false;
      if (quality === "plus" && !l.plus) return false;
      if (quality === "payments" && !(l.payments?.length ?? 0)) return false;
      if (quality === "new" && !isNewLaunch(l)) return false;
      if (market !== "all" && marketOf(l) !== market) return false;
      if (!needle) return true;
      return (
        l.domain.toLowerCase().includes(needle) ||
        l.name.toLowerCase().includes(needle)
      );
    });
    return sortLeads(filtered, sort);
  }, [leads, quality, market, sort, q]);

  const money = (l: Lead) =>
    l.priceMin != null
      ? `${l.currency && l.currency !== "ZAR" ? l.currency + " " : "R"}${l.priceMin}–${l.priceMax}`
      : "—";

  const reset = () => setShown(PAGE);

  return (
    <div className="mt-8 rounded-[2rem] bg-paper p-6 text-ink md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-bold">
          Leads{" "}
          <span className="text-sm font-normal text-ink/45">
            {rows.length} of {leads.length}
          </span>
        </h2>
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            reset();
          }}
          placeholder="Search store or domain…"
          className="rounded-full border border-ink/15 bg-transparent px-4 py-1.5 text-sm outline-none placeholder:text-ink/35 focus:border-ink/50"
        />
      </div>

      {/* Market row */}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-ink/40">
          Market
        </span>
        {markets.map((m) => (
          <button
            key={m.key}
            onClick={() => {
              setMarket(m.key);
              reset();
            }}
            className={`rounded-full px-3.5 py-1.5 text-sm transition ${
              market === m.key
                ? "bg-ink text-cream"
                : "border border-ink/15 text-ink/60 hover:border-ink/40"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Quality + sort row */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-ink/40">
          Show
        </span>
        {qualityFilters.map((f) => (
          <button
            key={f.key}
            onClick={() => {
              setQuality(f.key);
              reset();
            }}
            className={`rounded-full px-3.5 py-1.5 text-sm transition ${
              quality === f.key
                ? "bg-ink text-cream"
                : "border border-ink/15 text-ink/60 hover:border-ink/40"
            }`}
          >
            {f.label}
          </button>
        ))}
        <span className="ml-auto mr-1 text-xs font-semibold uppercase tracking-wide text-ink/40">
          Sort
        </span>
        {sorts.map((sopt) => (
          <button
            key={sopt.key}
            onClick={() => setSort(sopt.key)}
            className={`rounded-full px-3.5 py-1.5 text-sm transition ${
              sort === sopt.key
                ? "bg-orange text-cream"
                : "border border-ink/15 text-ink/60 hover:border-ink/40"
            }`}
          >
            {sopt.label}
          </button>
        ))}
      </div>

      <div className="mt-6 overflow-x-auto">
        <table className="w-full min-w-[920px] text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-ink/40">
            <tr>
              <th className="pb-3 pr-4">Store</th>
              <th className="pb-3 pr-4">Market</th>
              <th className="pb-3 pr-4">Products</th>
              <th className="pb-3 pr-4">Price range</th>
              <th className="pb-3 pr-4">Payments</th>
              <th className="pb-3 pr-4">Launched</th>
              <th className="pb-3 pr-4">Contact</th>
              <th className="pb-3">First seen</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, shown).map((l) => (
              <tr key={l.domain} className="border-t border-ink/10 align-top">
                <td className="py-4 pr-4">
                  <div className="flex flex-wrap items-center gap-1.5 font-semibold">
                    {l.name}
                    {l.plus && (
                      <span className="rounded-full bg-lilac px-2 py-0.5 text-[10px] font-bold">
                        PLUS
                      </span>
                    )}
                    {isNewLaunch(l) && (
                      <span className="rounded-full bg-mint px-2 py-0.5 text-[10px] font-bold">
                        NEW LAUNCH
                      </span>
                    )}
                  </div>
                  <a
                    href={l.finalUrl ?? `https://${l.domain}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-ink/50 underline-offset-2 hover:underline"
                  >
                    {l.domain}
                  </a>
                </td>
                <td className="py-4 pr-4 whitespace-nowrap text-ink/70">
                  {marketOf(l)}
                </td>
                <td className="py-4 pr-4">{l.productCount ?? "—"}</td>
                <td className="py-4 pr-4 whitespace-nowrap">{money(l)}</td>
                <td className="py-4 pr-4">
                  {l.payments?.length ? (
                    <div className="flex flex-wrap gap-1">
                      {l.payments.slice(0, 3).map((p) => (
                        <span
                          key={p}
                          className="rounded-full bg-mint/50 px-2 py-0.5 text-[10px] font-medium"
                        >
                          {p}
                        </span>
                      ))}
                      {l.payments.length > 3 && (
                        <span className="text-[10px] text-ink/40">
                          +{l.payments.length - 3}
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="text-ink/30">—</span>
                  )}
                </td>
                <td className="py-4 pr-4 whitespace-nowrap">
                  {l.firstProductAt ?? "—"}
                </td>
                <td className="py-4 pr-4">
                  {l.email ? (
                    <a href={`mailto:${l.email}`} className="text-orange">
                      {l.email}
                    </a>
                  ) : (
                    <span className="text-ink/30">—</span>
                  )}
                </td>
                <td className="py-4 whitespace-nowrap text-ink/60">
                  {l.firstSeen}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="py-10 text-center text-ink/50">
            No stores match these filters.
          </p>
        )}
      </div>

      {shown < rows.length && (
        <button
          onClick={() => setShown((s) => s + PAGE)}
          className="mt-6 w-full rounded-full border border-ink/15 py-3 text-sm font-medium text-ink/70 transition hover:border-ink/40"
        >
          Show {Math.min(PAGE, rows.length - shown)} more
        </button>
      )}
    </div>
  );
}
