"use client";

import { useEffect, useMemo, useState, type MouseEvent } from "react";

type Status = { selling: number; active: number; dormant: number; other: number; total: number };
type Series = { id: string; now: number; dated: number; status: Status };
type Point = { date: string; v: Record<string, number> };
type Scope = "published" | "detected";
type Data = { points: Point[]; series: Series[]; since: string; scope: Scope };

/** Brand colours where a platform has one people recognise, then a ramp from the app palette.
 *  "Other" is deliberately the dimmest — it is a fold, not a platform. */
const BRAND: Record<string, string> = {
  Shopify: "#95BF47",
  WooCommerce: "#96588a",
  WordPress: "#3858e9",
  Wix: "#faad4d",
  Magento: "#f26322",
  Shopware: "#179bd7",
  Centra: "#111111",
  BASE: "#00b900",
  Squarespace: "#c9c9c9",
  Webflow: "#4a7cf7",
};
const RAMP = ["#4cc9d4", "#cdeaa9", "#cabdf5", "#e8622c", "#8fb0c4", "#f4a261"];
const OTHER = "#6b7f7e";
const colorFor = (id: string, i: number) =>
  id === "Other" ? OTHER : BRAND[id] ?? RAMP[i % RAMP.length];

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtMonth = (iso: string) => { const [y, m] = iso.split("-").map(Number); return `${MON[m - 1]} '${String(y).slice(2)}`; };
const slug = (s: string) => s.replace(/[^a-z0-9]/gi, "");

/** Cumulative platform-growth chart for the combined view — one line per platform, showing how
 *  each one's live base has grown by launch cohort. Legend chips reveal the current
 *  selling/active/dormant split on hover.
 *
 *  Was two hardcoded lines where "Shopify" meant "not WooCommerce", so ~40,000 WordPress / JP-platform
 *  / Wix / Magento stores were drawn as Shopify. Now every platform is its own series, with the tail
 *  beyond the top few folded into "Other".
 *
 *  Renders only on the "all" platform view. Fetches paid-gated /api/platform-growth. */
export function PlatformGrowthChart({ country, provider }: { country?: string; provider?: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [legend, setLegend] = useState<string | null>(null);
  // Published = confirmed stores we surface. Detected = everything the crawlers classified.
  // Non-Shopify platforms are landed unpublished pending verification, so "published" can only
  // ever show Shopify vs Woo — "detected" is what "growth across all CMSs" actually means.
  const [scope, setScope] = useState<Scope>("published");
  const noun = provider ? "merchants" : "stores";

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      setLoading(true); setErr(null);
      const p = new URLSearchParams();
      if (country) p.set("country", country);
      if (provider) p.set("provider", provider);
      if (scope === "detected") p.set("scope", "detected");
      try {
        const r = await fetch(`/api/platform-growth?${p.toString()}`, { signal: ac.signal });
        if (!r.ok) throw new Error(r.status === 403 ? "Subscribers only" : "Couldn't load");
        setData(await r.json());
      } catch (e) {
        if ((e as Error).name !== "AbortError") setErr((e as Error).message);
      } finally { setLoading(false); }
    })();
    return () => ac.abort();
  }, [country, provider, scope]);

  // Default to the recent, readable window (2022+); expand to the full vintage arc (back to 2013,
  // where launch dates begin) on demand. The API always returns the full series, so this is a pure
  // client-side slice — the cumulative y-values already run to the current total either way.
  const [expanded, setExpanded] = useState(false);
  const allPts = useMemo(() => data?.points ?? [], [data]);
  const COLLAPSE_FROM = "2022-01-01";
  const pts = useMemo(
    () => (expanded ? allPts : allPts.filter((p) => p.date >= COLLAPSE_FROM)),
    [allPts, expanded],
  );
  const canExpand = allPts.length > 0 && allPts[0].date < COLLAPSE_FROM;
  const startYear = pts[0]?.date?.slice(0, 4) ?? (expanded ? "2013" : "2022");

  // A platform gets a trajectory line only if we have launch dates for ENOUGH of its live base for
  // the slope to be representative (dated in-window launches ≥ 20% of the current live total). The
  // line ends at the current total (it starts from a baseline), so gate on the DATED portion, not
  // the endpoint. A platform below the bar still gets its chip + status split — drawing a near-flat
  // line from thin dating would mislead.
  const series = useMemo(() => data?.series ?? [], [data]);
  const drawn = useMemo(
    () => series.filter((s) => pts.length > 1 && s.now > 0 && s.dated / s.now >= 0.2),
    [series, pts.length],
  );

  const W = 760, H = 280, padL = 46, padR = 16, padB = 34, padT = 16;
  const iw = W - padL - padR, ih = H - padT - padB;
  const max = Math.max(1, ...pts.flatMap((p) => drawn.map((s) => p.v[s.id] ?? 0)));
  const stepX = pts.length > 1 ? iw / (pts.length - 1) : iw;
  const xAt = (i: number) => padL + i * stepX;
  const yAt = (v: number) => padT + ih - (v / max) * ih;
  const path = (id: string) =>
    pts.map((p, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(p.v[id] ?? 0).toFixed(1)}`).join(" ");
  const area = (id: string) =>
    pts.length ? `${path(id)} L${xAt(pts.length - 1).toFixed(1)},${padT + ih} L${xAt(0).toFixed(1)},${padT + ih} Z` : "";
  const labelEvery = Math.max(1, Math.ceil(pts.length / 8));

  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round((((e.clientX - r.left) / r.width) * W - padL) / stepX);
    setHover(i >= 0 && i < pts.length ? i : null);
  };
  const hp = hover != null ? pts[hover] : null;

  const StatusPop = ({ s, id, color }: { s: Status; id: string; color: string }) => (
    <div className="absolute bottom-full right-0 z-20 mb-2 w-52 rounded-xl border border-cream/20 bg-ink-deep/95 p-3 text-xs shadow-xl">
      <div className="mb-1.5 font-semibold" style={{ color }}>
        {id} · {s.total.toLocaleString()} live
      </div>
      <ul className="space-y-1">
        <li className="flex justify-between"><span className="text-cream/60">Selling (verified)</span><span className="tabular-nums text-mint">{s.selling.toLocaleString()}</span></li>
        <li className="flex justify-between"><span className="text-cream/60">Active (live)</span><span className="tabular-nums text-cyan">{s.active.toLocaleString()}</span></li>
        {s.dormant > 0 && <li className="flex justify-between"><span className="text-cream/60">Dormant (built, idle)</span><span className="tabular-nums text-orange">{s.dormant.toLocaleString()}</span></li>}
        {s.other > 0 && <li className="flex justify-between"><span className="text-cream/60">Parked / other</span><span className="tabular-nums text-cream/50">{s.other.toLocaleString()}</span></li>}
      </ul>
    </div>
  );

  return (
    <div className="rounded-[2rem] border border-cream/12 bg-cream/[0.03] p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold">{provider ? `${provider} growth by platform` : "Platform growth"}</h3>
          <p className="mt-1 text-sm text-cream/45">{provider ? `Cumulative ${provider} merchants by platform — where it's winning.` : "Cumulative live stores by launch cohort — who's growing faster."}</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* scope toggle — the reason non-Shopify platforms were invisible */}
          <div className="mr-1 flex overflow-hidden rounded-full border border-cream/12 text-xs">
            {(["published", "detected"] as const).map((sc) => (
              <button key={sc} onClick={() => setScope(sc)}
                title={sc === "published" ? "Confirmed stores we surface to customers" : "Everything the crawlers have classified, including unverified"}
                className={`px-3 py-1.5 ${scope === sc ? "bg-cream/15 text-cream" : "text-cream/55 hover:text-cream"}`}>
                {sc === "published" ? "Confirmed" : "All detected"}
              </button>
            ))}
          </div>
          {series.map((s, i) => {
            const color = colorFor(s.id, i);
            return (
              <div key={s.id} className="relative" onMouseEnter={() => setLegend(s.id)} onMouseLeave={() => setLegend(null)}>
                <button className="flex items-center gap-1.5 rounded-full border border-cream/12 px-3 py-1.5 text-xs text-cream/75 hover:border-cream/30">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
                  {s.id}
                  <span className="tabular-nums text-cream/50">{s.now.toLocaleString()}</span>
                </button>
                {legend === s.id && <StatusPop s={s.status} id={s.id} color={color} />}
              </div>
            );
          })}
        </div>
      </div>

      <div className="relative mt-5" onMouseLeave={() => setHover(null)}>
        {loading ? (
          <div className="grid h-64 place-items-center text-sm text-cream/40">Loading…</div>
        ) : err ? (
          <div className="grid h-64 place-items-center text-sm text-orange">{err}</div>
        ) : !drawn.length ? (
          <div className="grid h-64 place-items-center text-sm text-cream/40">Not enough dated {noun} yet to chart growth.</div>
        ) : (
          <>
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full" onMouseMove={onMove}>
              {/* y gridlines */}
              {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                <g key={f}>
                  <line x1={padL} y1={padT + ih - f * ih} x2={W - padR} y2={padT + ih - f * ih} stroke="var(--color-cream)" strokeOpacity="0.08" />
                  <text x={padL - 6} y={padT + ih - f * ih + 3} textAnchor="end" fill="var(--color-cream)" fillOpacity="0.4" fontSize="10">{Math.round(max * f).toLocaleString()}</text>
                </g>
              ))}
              <defs>
                {drawn.map((s, i) => {
                  const c = colorFor(s.id, series.findIndex((x) => x.id === s.id));
                  return (
                    <linearGradient key={s.id} id={`pg${slug(s.id)}`} x1="0" x2="0" y1="0" y2="1">
                      <stop offset="0" stopColor={c} stopOpacity="0.18" /><stop offset="1" stopColor={c} stopOpacity="0" />
                    </linearGradient>
                  );
                })}
              </defs>
              {/* Only the largest drawn series gets a fill — stacking translucent areas for six
                  platforms turns the plot into mud. The rest read as lines. */}
              {drawn.length > 0 && <path d={area(drawn[0].id)} fill={`url(#pg${slug(drawn[0].id)})`} />}
              {drawn.map((s) => (
                <path key={s.id} d={path(s.id)} fill="none"
                  stroke={colorFor(s.id, series.findIndex((x) => x.id === s.id))}
                  strokeWidth="2.5" strokeLinejoin="round" />
              ))}
              {/* hover guide + dots */}
              {hover != null && (
                <>
                  <line x1={xAt(hover)} y1={padT} x2={xAt(hover)} y2={padT + ih} stroke="var(--color-cream)" strokeOpacity="0.25" />
                  {drawn.map((s) => (
                    <circle key={s.id} cx={xAt(hover)} cy={yAt(hp?.v[s.id] ?? 0)} r="3.5"
                      fill={colorFor(s.id, series.findIndex((x) => x.id === s.id))} />
                  ))}
                </>
              )}
              {/* x labels */}
              {pts.map((p, i) => (i % labelEvery === 0 ? (
                <text key={p.date} x={xAt(i)} y={H - 12} textAnchor="middle" fill="var(--color-cream)" fillOpacity="0.4" fontSize="10">{fmtMonth(p.date)}</text>
              ) : null))}
            </svg>

            {hp && (
              <div className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 rounded-xl border border-cream/20 bg-ink-deep/95 px-3 py-2 text-xs shadow-xl">
                <div className="mb-1 font-semibold text-cream/80">{fmtMonth(hp.date)}</div>
                <ul className="space-y-0.5">
                  {drawn.map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-4">
                      <span className="flex items-center gap-1.5 text-cream/60">
                        <span className="h-2 w-2 rounded-full" style={{ background: colorFor(s.id, series.findIndex((x) => x.id === s.id)) }} />
                        {s.id}
                      </span>
                      <span className="tabular-nums text-cream">{(hp.v[s.id] ?? 0).toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-cream/35">
        {data?.scope === "detected"
          ? <><b className="text-cream/55">All detected:</b> includes platforms landed but not yet verified, so counts run ahead of what customers see. </>
          : <><b className="text-cream/55">Confirmed only:</b> non-Shopify platforms are landed unpublished pending verification, so they appear under “All detected”. </>}
        Cumulative live {noun} by launch cohort from {startYear}. Lines start from a baseline (already live, or
        not yet launch-dated) so each ends at its real current total. A platform is only drawn when dated launches
        cover ≥20% of its live base; the rest show as chips only. Older cohorts lean on store-creation dates as a
        launch proxy — early vintage is approximate.
        {canExpand && (
          <> <button onClick={() => setExpanded((v) => !v)} className="text-cream/60 underline hover:text-cream">
            {expanded ? "Show 2022 onwards" : "Show full history from 2013"}
          </button></>
        )}
      </p>
    </div>
  );
}
