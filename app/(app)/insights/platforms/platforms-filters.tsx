"use client";

import { useRouter, useSearchParams } from "next/navigation";

type Opt = { value: string; label: string };

export function PlatformFilters({ regions, cmsOptions, countryOptions }: { regions: Opt[]; cmsOptions: Opt[]; countryOptions: Opt[] }) {
  const router = useRouter();
  const sp = useSearchParams();
  const region = sp.get("region") ?? "global";
  const country = sp.get("country") ?? "";
  const cms = sp.get("cms") ?? "";

  const go = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) { if (v) p.set(k, v); else p.delete(k); }
    router.push(`/insights/platforms${p.toString() ? `?${p}` : ""}`);
  };

  const selCls = "rounded-full border border-cream/15 bg-transparent px-3 py-1.5 text-sm text-cream outline-none focus:border-cream/50";

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-2xl border border-cream/10 bg-cream/[0.02] px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-cream/40">Region</span>
        <div className="flex flex-wrap gap-1">
          {regions.map((r) => {
            const active = !country && region === r.value;
            return (
              <button key={r.value} onClick={() => go({ region: r.value === "global" ? null : r.value, country: null })}
                className={`rounded-full px-3 py-1.5 text-sm transition ${active ? "bg-cream text-ink" : "text-cream/60 hover:bg-cream/[0.06] hover:text-cream"}`}>{r.label}</button>
            );
          })}
        </div>
      </div>

      <label className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-cream/40">Country</span>
        <select className={selCls} value={country} onChange={(e) => go({ country: e.target.value || null })}>
          <option value="" className="text-ink">All in region</option>
          {countryOptions.map((c) => <option key={c.value} value={c.value} className="text-ink">{c.label}</option>)}
        </select>
      </label>

      <label className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-cream/40">CMS</span>
        <select className={selCls} value={cms} onChange={(e) => go({ cms: e.target.value || null })}>
          <option value="" className="text-ink">All platforms</option>
          {cmsOptions.map((c) => <option key={c.value} value={c.value} className="text-ink">{c.label}</option>)}
        </select>
      </label>
    </div>
  );
}
