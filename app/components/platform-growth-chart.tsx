"use client";

import { useEffect, useMemo, useState, type MouseEvent } from "react";

type Status = { selling: number; active: number; dormant: number; other: number; total: number };
type Series = { slug: string; label: string; now: number; dated: number; status: Status; cumulative: number[] };
type Data = { months: string[]; platforms: Series[]; since: string };

// Fixed brand-ish colours for the big ones; a rotating palette for the long tail.
const COLOR: Record<string, string> = {
  shopify: "#95BF47", woocommerce: "#96588a", wix: "#2b7fff", magento: "#f26322",
  adobe_commerce: "#f26322", squarespace: "#cbd5e1", shopstar: "#e8a33d", prestashop: "#df0067",
  bigcommerce: "#34313f", ecwid: "#2fb344",
};
const PALETTE = ["#4cc9f0", "#f72585", "#80ed99", "#ffd166", "#b5179e", "#43aa8b"];
const colorFor = (slug: string, i: number) => COLOR[slug] ?? PALETTE[i % PALETTE.length];

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtMonth = (iso: string) => { const [y, m] = iso.split("-").map(Number); return `${MON[m - 1]} '${String(y).slice(2)}`; };

/** Cumulative platform-growth chart for the combined view — a line per CMS showing how each one's
 *  live base has grown by launch cohort, so a viewer can see which is growing faster. Every returned
 *  CMS gets a legend chip (hover for its selling/active/dormant split); a trajectory LINE is drawn
 *  only where enough of that CMS's base is launch-dated for the slope to be representative (dated ≥
 *  20% of its live total) — otherwise its chip total still shows. Renders on the "all" platform view;
 *  fetches paid-gated /api/platform-growth. */
export function PlatformGrowthChart({ country, provider }: { country?: string; provider?: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [legend, setLegend] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const noun = provider ? "merchants" : "stores";

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      setLoading(true); setErr(null);
      const p = new URLSearchParams();
      if (country) p.set("country", country);
      if (provider) p.set("provider", provider);
      try {
        const r = await fetch(`/api/platform-growth?${p.toString()}`, { signal: ac.signal });
        if (!r.ok) throw new Error(r.status === 403 ? "Subscribers only" : "Couldn't load");
        setData(await r.json());
      } catch (e) {
        if ((e as Error).name !== "AbortError") setErr((e as Error).message);
      } finally { setLoading(false); }
    })();
    return () => ac.abort();
  }, [country, provider]);

  // Default to the recent, readable window (2022+); expand to the full vintage arc (back to 2013) on
  // demand. Pure client-side slice — the cumulative y-values already run to the current total either way.
  const allMonths = useMemo(() => data?.months ?? [], [data]);
  const COLLAPSE_FROM = "2022-01-01";
  const startIdx = useMemo(() => {
    if (expanded) return 0;
    const i = allMonths.findIndex((m) => m >= COLLAPSE_FROM);
    return i < 0 ? 0 : i;   // if nothing is 2022+, show everything
  }, [allMonths, expanded]);
  const months = useMemo(() => allMonths.slice(startIdx), [allMonths, startIdx]);
  const canExpand = !expanded && startIdx > 0;
  const startYear = months[0]?.slice(0, 4) ?? (expanded ? "2013" : "2022");

  // A platform gets a LINE only if enough of its live base is launch-dated (≥20%), so a near-flat line
  // from sparse data can't mislead. All platforms still get a legend chip with their current total.
  const series = useMemo(
    () => (data?.platforms ?? []).map((p, i) => ({
      ...p, color: colorFor(p.slug, i), vis: p.cumulative.slice(startIdx),
      drawable: months.length > 1 && p.now > 0 && p.dated / p.now >= 0.2,
    })),
    [data, startIdx, months.length],
  );
  const drawn = series.filter((p) => p.drawable);

  const W = 760, H = 280, padL = 46, padR = 16, padB = 34, padT = 16;
  const iw = W - padL - padR, ih = H - padT - padB;
  const max = Math.max(1, ...drawn.flatMap((p) => p.vis));
  const stepX = months.length > 1 ? iw / (months.length - 1) : iw;
  const xAt = (i: number) => padL + i * stepX;
  const yAt = (v: number) => padT + ih - (v / max) * ih;
  const linePath = (vis: number[]) => vis.map((v, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(" ");
  const areaPath = (vis: number[]) => vis.length ? `${linePath(vis)} L${xAt(vis.length - 1).toFixed(1)},${padT + ih} L${xAt(0).toFixed(1)},${padT + ih} Z` : "";
  const labelEvery = Math.max(1, Math.ceil(months.length / 8));

  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round((((e.clientX - r.left) / r.width) * W - padL) / stepX);
    setHover(i >= 0 && i < months.length ? i : null);
  };

  const StatusPop = ({ p }: { p: Series & { color: string; drawable: boolean } }) => {
    const rows = ([
      ["Selling", p.status.selling, "text-mint"],
      [p.slug === "shopify" ? "Other live" : "Active (live, stocked)", p.status.active, "text-cyan"],
      ["Dormant (built, idle)", p.status.dormant, "text-orange"],
      ["Parked / other", p.status.other, "text-cream/50"],
    ] as [string, number, string][]).filter(([, v]) => v > 0);
    return (
      <div className="absolute bottom-full right-0 z-20 mb-2 w-56 rounded-xl border border-cream/20 bg-ink-deep/95 p-3 text-xs shadow-xl">
        <div className="mb-1.5 font-semibold" style={{ color: p.color }}>{p.label} · {p.status.total.toLocaleString()} live</div>
        <ul className="space-y-1">
          {rows.map(([lbl, v, cls]) => (
            <li key={lbl} className="flex justify-between"><span className="text-cream/60">{lbl}</span><span className={`tabular-nums ${cls}`}>{v.toLocaleString()}</span></li>
          ))}
        </ul>
        {!p.drawable && <p className="mt-1.5 text-[11px] leading-snug text-cream/40">Too few launch-dated {noun} to chart a trajectory yet — total only.</p>}
      </div>
    );
  };

  return (
    <div className="rounded-[2rem] border border-cream/12 bg-cream/[0.03] p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold">{provider ? `${provider} growth by platform` : "Platform growth — all CMSs"}</h3>
          <p className="mt-1 text-sm text-cream/45">{provider ? `Cumulative ${provider} merchants by platform — where it's winning.` : "Cumulative live stores by launch cohort — which platform is growing faster."}</p>
        </div>
        {/* legend chips — hover to reveal each platform's live-status split */}
        <div className="flex flex-wrap gap-2">
          {series.map((p) => (
            <div key={p.slug} className="relative" onMouseEnter={() => setLegend(p.slug)} onMouseLeave={() => setLegend(null)}>
              <button className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs text-cream/75 hover:border-cream/30 ${p.drawable ? "border-cream/12" : "border-dashed border-cream/15"}`}>
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: p.color, opacity: p.drawable ? 1 : 0.5 }} />
                {p.label}
                <span className="tabular-nums text-cream/50">{p.now.toLocaleString()}</span>
              </button>
              {legend === p.slug && <StatusPop p={p} />}
            </div>
          ))}
        </div>
      </div>

      <div className="relative mt-5" onMouseLeave={() => setHover(null)}>
        {loading ? (
          <div className="grid h-64 place-items-center text-sm text-cream/40">Loading…</div>
        ) : err ? (
          <div className="grid h-64 place-items-center text-sm text-orange">{err}</div>
        ) : drawn.length === 0 ? (
          <div className="grid h-64 place-items-center text-sm text-cream/40">Not enough dated {noun} yet to chart growth.</div>
        ) : (
          <>
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full" onMouseMove={onMove} style={{ fontFamily: "var(--font-mono)" }}>
              {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                <g key={f}>
                  <line x1={padL} y1={padT + ih - f * ih} x2={W - padR} y2={padT + ih - f * ih} stroke="var(--color-cream)" strokeOpacity="0.08" />
                  <text x={padL - 6} y={padT + ih - f * ih + 3} textAnchor="end" fill="var(--color-cream)" fillOpacity="0.4" fontSize="10">{Math.round(max * f).toLocaleString()}</text>
                </g>
              ))}
              <defs>
                {drawn.map((p) => (
                  <linearGradient key={p.slug} id={`pg-${p.slug}`} x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0" stopColor={p.color} stopOpacity="0.2" /><stop offset="1" stopColor={p.color} stopOpacity="0" />
                  </linearGradient>
                ))}
              </defs>
              {drawn.map((p) => <path key={`a-${p.slug}`} d={areaPath(p.vis)} fill={`url(#pg-${p.slug})`} />)}
              {drawn.map((p) => <path key={`l-${p.slug}`} d={linePath(p.vis)} fill="none" stroke={p.color} strokeWidth="2.5" strokeLinejoin="round" />)}
              {hover != null && (
                <>
                  <line x1={xAt(hover)} y1={padT} x2={xAt(hover)} y2={padT + ih} stroke="var(--color-cream)" strokeOpacity="0.25" />
                  {drawn.map((p) => <circle key={`d-${p.slug}`} cx={xAt(hover)} cy={yAt(p.vis[hover])} r="3.5" fill={p.color} />)}
                </>
              )}
              {months.map((m, i) => (i % labelEvery === 0 ? (
                <text key={m} x={xAt(i)} y={H - 12} textAnchor="middle" fill="var(--color-cream)" fillOpacity="0.55" fontSize="11">{fmtMonth(m)}</text>
              ) : null))}
            </svg>
            {hover != null && (
              <div className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-lg border border-cream/20 bg-ink-deep/95 px-3 py-2 text-xs shadow-xl"
                style={{ left: `${Math.min(84, Math.max(16, (xAt(hover) / W) * 100))}%`, top: 0 }}>
                <div className="font-semibold text-cream">{fmtMonth(months[hover])}</div>
                {drawn.map((p) => <div key={p.slug} className="mt-0.5" style={{ color: p.color }}>{p.vis[hover].toLocaleString()} {p.label}</div>)}
              </div>
            )}
          </>
        )}
      </div>

      {canExpand && (
        <div className="mt-3 flex justify-center">
          <button onClick={() => setExpanded(true)} className="rounded-full border border-cream/15 px-3.5 py-1 text-xs text-cream/60 transition hover:border-cream/40 hover:text-cream">↔ Show full history (since 2013)</button>
        </div>
      )}
      {expanded && (
        <div className="mt-3 flex justify-center">
          <button onClick={() => setExpanded(false)} className="rounded-full border border-cream/15 px-3.5 py-1 text-xs text-cream/60 transition hover:border-cream/40 hover:text-cream">↕ Collapse to 2022+</button>
        </div>
      )}
      <p className="mt-3 text-xs text-cream/35">
        Each line starts from the {noun} already live at {startYear} (plus any not yet launch-dated) and adds each month&rsquo;s launches, so it ends at that platform&rsquo;s current total — the slope is the observed growth. {expanded ? <>Older cohorts use StoreLeads&rsquo; store-creation date as a launch proxy (approximate); recent months use our own product/cert dates. </> : null}Hover a legend chip for the live selling/active/dormant split. A CMS whose launch-dates are still being built shows as a dashed chip (total only) until enough of its base is dated to draw a representative line.
      </p>
    </div>
  );
}
