"use client";

import { useEffect, useState, type MouseEvent } from "react";

type Provider = { label: string; type: string; total: number; cumulative: number[] };
type Grain = "month" | "quarter" | "year";
type Series = { granularity: Grain; buckets: string[]; providers: Provider[]; storesCumulative: number[] };

// Distinct on the dark ground; first four are brand tokens, last two harmonise with them.
const PALETTE = ["var(--color-cyan)", "var(--color-orange)", "var(--color-mint)", "var(--color-lilac)", "#e8c468", "#e88fb0"];
const GRAINS = [["year", "Year"], ["quarter", "Quarter"], ["month", "Month"]] as const;
// PSPs we always surface on the main chart even if they're not in the volume top-N (Joel, 2026-11-05).
const PSP_PINS = ["Peach Payments", "PayGate", "PayU"];
const MAX_LINES = 6;

function fmtBucket(iso: string, g: Grain, first: boolean): string {
  const dt = new Date(iso + "T00:00:00Z");
  const yy = String(dt.getUTCFullYear()).slice(2);
  if (g === "year") return first ? `≤${dt.getUTCFullYear()}` : `'${yy}`;
  const mo = dt.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
  if (g === "quarter") return `${first ? "≤" : ""}Q${Math.floor(dt.getUTCMonth() / 3) + 1} '${yy}`;
  return `${first ? "≤" : ""}${mo} '${yy}`;
}
function fmtBucketFull(iso: string, g: Grain, first: boolean): string {
  const dt = new Date(iso + "T00:00:00Z");
  const pre = first ? "By " : g === "year" ? "By end of " : "In ";
  if (g === "year") return `${first ? "Launched " : "By end of "}${dt.getUTCFullYear()}${first ? " or earlier" : ""}`;
  const mo = dt.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  if (g === "quarter") return `${pre}Q${Math.floor(dt.getUTCMonth() / 3) + 1} ${dt.getUTCFullYear()}`;
  return `${pre}${mo}`;
}

/** One adoption panel (a single gateway type). Shares the fetched series + the cumulative/per-period
 *  and count/share toggles with its siblings; picks the leaders within its type (pins forced in). */
function AdoptionPanel({
  series, type, title, hint, metric, view, pins = [],
}: {
  series: Series | null;
  type: string;
  title: string;
  hint: string;
  metric: "count" | "share";
  view: "cumulative" | "period";
  pins?: string[];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const g = series?.granularity ?? "year";
  const buckets = series?.buckets ?? [];
  const stores = series?.storesCumulative ?? [];
  const inType = (series?.providers ?? []).filter((p) => p.type === type);
  // Pinned providers first (if present in this type), then the highest-volume others, up to MAX_LINES.
  const pinned = pins.map((name) => inType.find((p) => p.label === name)).filter(Boolean) as Provider[];
  const rest = inType.filter((p) => !pins.includes(p.label));
  const provs = [...pinned, ...rest].slice(0, MAX_LINES);

  const share = metric === "share";
  const periodMode = view === "period";
  const delta = (arr: number[], i: number) => (i === 0 ? arr[i] ?? 0 : (arr[i] ?? 0) - (arr[i - 1] ?? 0));
  const valAt = (p: Provider, i: number) => {
    if (!periodMode) return share ? (stores[i] ? (100 * p.cumulative[i]) / stores[i] : 0) : p.cumulative[i];
    const dv = Math.max(0, delta(p.cumulative, i));
    if (!share) return dv;
    const ds = Math.max(0, delta(stores, i));
    return ds ? (100 * dv) / ds : 0;
  };
  const fmtV = (v: number) => (share ? `${v.toFixed(v < 10 ? 1 : 0)}%` : Math.round(v).toLocaleString());

  const W = 760, H = 280, padL = 44, padR = 96, padB = 34, padT = 14;
  const iw = W - padL - padR, ih = H - padT - padB;
  const n = buckets.length;
  const maxY = Math.max(share ? 1 : 1, ...provs.flatMap((p) => buckets.map((_, i) => valAt(p, i))));
  const xAt = (i: number) => padL + (n > 1 ? (i / (n - 1)) * iw : 0);
  const yAt = (v: number) => padT + ih - (v / maxY) * ih;
  const path = (p: Provider) => buckets.map((_, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(valAt(p, i)).toFixed(1)}`).join(" ");
  const labelEvery = Math.max(1, Math.ceil(n / 8));
  const yTicks = 4;
  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W - padL;
    const i = Math.round((x / iw) * (n - 1));
    setHover(i >= 0 && i < n ? i : null);
  };

  return (
    <div className="rounded-[1.5rem] border border-cream/12 bg-cream/[0.03] p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="font-semibold text-cream">{title}</h4>
          <p className="mt-0.5 text-xs text-cream/45">{hint}</p>
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {provs.map((p, i) => (
            <span key={p.label} className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: PALETTE[i % PALETTE.length] }} />
              <span className="text-cream/80">{p.label}</span>
              <span className="text-cream/40">{p.total.toLocaleString()}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="relative mt-3" onMouseLeave={() => setHover(null)}>
        {provs.length === 0 ? (
          <div className="grid h-48 place-items-center text-sm text-cream/40">No {type} providers with dated launches in this market yet.</div>
        ) : (
          <>
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full" onMouseMove={onMove} style={{ fontFamily: "var(--font-mono)" }}>
              {Array.from({ length: yTicks + 1 }, (_, k) => {
                const v = (maxY / yTicks) * k, y = yAt(v);
                return (
                  <g key={k}>
                    <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="var(--color-cream)" strokeOpacity="0.08" />
                    <text x={padL - 6} y={y + 3} textAnchor="end" fill="var(--color-cream)" fillOpacity="0.4" fontSize="10">{fmtV(v)}</text>
                  </g>
                );
              })}
              {buckets.map((b, i) => (i % labelEvery === 0 || i === n - 1) ? (
                <text key={b} x={xAt(i)} y={H - 12} textAnchor="middle" fill="var(--color-cream)" fillOpacity="0.5" fontSize="10">{fmtBucket(b, g, i === 0)}</text>
              ) : null)}
              {hover != null && <line x1={xAt(hover)} y1={padT} x2={xAt(hover)} y2={padT + ih} stroke="var(--color-cream)" strokeOpacity="0.18" />}
              {provs.map((p, i) => {
                const c = PALETTE[i % PALETTE.length];
                const last = n - 1;
                return (
                  <g key={p.label}>
                    <path d={path(p)} fill="none" stroke={c} strokeWidth="2" strokeLinejoin="round" opacity={hover == null ? 0.95 : 0.5} />
                    <circle cx={xAt(last)} cy={yAt(valAt(p, last))} r="3" fill={c} opacity={hover == null ? 1 : 0.5} />
                    {hover != null && <circle cx={xAt(hover)} cy={yAt(valAt(p, hover))} r="3.5" fill={c} />}
                  </g>
                );
              })}
            </svg>
            {hover != null && series && buckets[hover] && (
              <div className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-lg border border-cream/20 bg-ink-deep/95 px-3 py-2 text-xs shadow-xl"
                style={{ left: `${Math.min(84, Math.max(16, (xAt(hover) / W) * 100))}%`, top: 0 }}>
                <div className="font-semibold text-cream">{fmtBucketFull(buckets[hover], g, hover === 0)}</div>
                {[...provs].sort((a, b) => valAt(b, hover) - valAt(a, hover)).map((p) => (
                  <div key={p.label} className="mt-0.5 flex items-center gap-1.5">
                    <span className="inline-block h-2 w-2 rounded-sm" style={{ background: PALETTE[provs.indexOf(p) % PALETTE.length] }} />
                    <span className="text-cream/75">{p.label}</span>
                    <span className="ml-auto pl-3 font-medium text-cream tabular-nums">{fmtV(valAt(p, hover))}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Payment-provider adoption over ~10 years, bucketable by Month / Quarter / Year — a best estimate
 *  of when each currently-live store chose its provider (credited to its launch bucket). Split into
 *  three panels so each gateway type reads on its own scale: gateways (PSP), BNPL, and alt-methods
 *  (APM). Cumulative = installed base captured; Per-period = how each provider did in that bucket
 *  alone (the acquisition view). Client-fetched from the cached /api/provider-adoption. */
export function ProviderAdoptionChart({ country, platform }: { country: string; platform: string }) {
  const [data, setData] = useState<Series | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [grain, setGrain] = useState<Grain>("year");
  const [view, setView] = useState<"cumulative" | "period">("cumulative");
  const [metric, setMetric] = useState<"count" | "share">("count");

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      setLoading(true); setErr(null);
      const p = new URLSearchParams({ country, grain });
      if (platform && platform !== "all") p.set("platform", platform);
      try {
        const r = await fetch(`/api/provider-adoption?${p.toString()}`, { signal: ac.signal });
        if (!r.ok) throw new Error(r.status === 403 ? "Subscribers only" : "Couldn't load");
        setData(await r.json());
      } catch (e) {
        if ((e as Error).name !== "AbortError") setErr((e as Error).message);
      } finally { setLoading(false); }
    })();
    return () => ac.abort();
  }, [country, platform, grain]);

  const Toggle = <T extends string>(opts: readonly (readonly [T, string])[], val: T, set: (v: T) => void, title: string) => (
    <div className="flex gap-1 rounded-full border border-cream/12 p-1" title={title}>
      {opts.map(([k, l]) => (
        <button key={k} onClick={() => set(k)}
          className={`rounded-full px-3 py-1 text-xs transition ${val === k ? "bg-cyan font-semibold text-cyan-deep" : "text-cream/50 hover:text-cream"}`}>{l}</button>
      ))}
    </div>
  );

  return (
    <div className="rounded-[2rem] border border-cream/12 bg-cream/[0.03] p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold">Payment provider adoption — last 10 years</h3>
          <p className="mt-1 text-sm text-cream/45">
            {view === "cumulative"
              ? (metric === "share"
                  ? "Market penetration per provider — % of each launch cohort that carries it (a store can use several)."
                  : "Cumulative merchants per provider, credited to each store's launch bucket (best estimate of when they chose it).")
              : (metric === "share"
                  ? "Per-period win rate — of stores that launched in each bucket, the % that chose each provider."
                  : "New merchants per provider in each bucket alone — how they did that period, not the running total.")}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          {Toggle(GRAINS, grain, setGrain, "time granularity")}
          <div className="flex gap-2">
            {Toggle([["cumulative", "Cumulative"], ["period", "Per-period"]] as const, view, setView, "running installed base vs. what each provider won in that bucket alone")}
            {Toggle([["count", "Count"], ["share", "Share %"]] as const, metric, setMetric, "absolute merchant counts vs. each provider's share of the market")}
          </div>
        </div>
      </div>

      <div className="relative mt-5">
        {loading ? (
          <div className="grid h-64 place-items-center text-sm text-cream/40">Loading…</div>
        ) : err ? (
          <div className="grid h-64 place-items-center text-sm text-orange">{err}</div>
        ) : (
          <div className="space-y-5">
            <AdoptionPanel series={data} type="PSP" title="Payment gateways · PSP" hint="The acquirers/gateways — Peach Payments, PayGate and PayU are always shown." metric={metric} view={view} pins={PSP_PINS} />
            <div className="grid gap-5 lg:grid-cols-2">
              <AdoptionPanel series={data} type="BNPL" title="Buy-now-pay-later · BNPL" hint="Instalment credit (Payflex, PayJustNow, Mobicred…)." metric={metric} view={view} />
              <AdoptionPanel series={data} type="APM" title="Alt. methods · APM" hint="Wallets, EFT & rails (Ozow, SnapScan, Apple Pay…)." metric={metric} view={view} />
            </div>
          </div>
        )}
      </div>

      <p className="mt-4 text-xs text-cream/35">
        Best estimate: each currently-live store&rsquo;s provider is credited to its real launch bucket (first product / launched_at),
        assuming the merchant chose it at launch. Survivorship-adjusted (live stores only) and pre-switch-tracking —
        going forward the switch log refines exactly who moved and when.
      </p>
    </div>
  );
}
