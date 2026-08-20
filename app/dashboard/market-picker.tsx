"use client";

import { marketLabel } from "@/lib/markets";

/** Market dropdown for the dashboard — navigates to /dashboard?country=CODE.
 *  Only shown when more than one market has live stores. */
export function MarketPicker({
  countries,
  country,
}: {
  countries: { country: string; stores: number }[];
  country: string;
}) {
  if (countries.length < 2) return null;
  return (
    <select
      value={country}
      onChange={(e) => { window.location.href = `/dashboard?country=${e.target.value}`; }}
      className="rounded-full border border-cream/20 bg-transparent px-4 py-1.5 text-sm text-cream/80 outline-none focus:border-cream/50"
      aria-label="Market"
    >
      {countries.map((c) => (
        <option key={c.country} value={c.country} className="text-ink">
          {marketLabel(c.country)} ({c.stores.toLocaleString()})
        </option>
      ))}
    </select>
  );
}
