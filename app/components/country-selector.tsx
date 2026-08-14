"use client";

import { useState } from "react";

type Country = {
  code: string;
  name: string;
  flag: string;
  count?: number;
  live: boolean;
};

// South Africa is live; the rest are announced but not yet open.
const COUNTRIES: Country[] = [
  { code: "ZA", name: "South Africa", flag: "🇿🇦", count: 531, live: true },
  { code: "NG", name: "Nigeria", flag: "🇳🇬", live: false },
  { code: "KE", name: "Kenya", flag: "🇰🇪", live: false },
  { code: "EG", name: "Egypt", flag: "🇪🇬", live: false },
  { code: "MA", name: "Morocco", flag: "🇲🇦", live: false },
];

export function CountrySelector() {
  const [code, setCode] = useState("ZA");
  const c = COUNTRIES.find((x) => x.code === code)!;

  return (
    <div className="mx-auto mt-4 w-full max-w-md rounded-[2rem] border border-cream/12 bg-cream/[0.04] p-6 text-center">
      <label className="text-xs font-semibold uppercase tracking-wide text-cream/45">
        Choose your market
      </label>
      <div className="relative mt-3">
        <select
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="w-full appearance-none rounded-full border border-cream/20 bg-ink px-5 py-3 text-center text-lg font-medium text-cream outline-none focus:border-cream/50"
        >
          {COUNTRIES.map((x) => (
            <option key={x.code} value={x.code}>
              {x.flag} {x.name}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-5">
        {c.live ? (
          <>
            <div className="font-display text-6xl leading-none tracking-tight">
              {c.count?.toLocaleString()}
            </div>
            <div className="mt-2 text-sm text-cream/60">
              {c.flag} stores tracked in {c.name} · growing daily
            </div>
          </>
        ) : (
          <>
            <div className="font-display text-4xl leading-none tracking-tight text-cream/70">
              {c.flag} {c.name}
            </div>
            <div className="mt-3 inline-block rounded-full border border-mint/25 bg-mint/10 px-4 py-1.5 text-sm font-semibold text-mint">
              Coming soon
            </div>
            <p className="mt-3 text-sm text-cream/50">
              We&apos;re expanding across Africa — {c.name} is next in line.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
