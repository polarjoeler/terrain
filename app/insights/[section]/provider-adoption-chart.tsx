"use client";

import { useEffect, useState, type MouseEvent } from "react";

type Provider = { label: string; type: string; total: number; cumulative: number[] };
type Series = { years: number[]; startYear: number; baselineYear: number; providers: Provider[] };

// Distinct on the dark ground; first four are brand tokens, last two harmonise with them.
const PALETTE = ["var(--color-cyan)", "var(--color-orange)", "var(--color-mint)", "var(--color-lilac)", "#e8c468", "#e88fb0"];
const TYPES = [["all", "All"], ["PSP", "PSP"], ["BNPL", "BNPL"], ["APM", "APM"]] as const;
const TYPE_HINT: Record<string, string> = {
  all: "every gateway type", PSP: "payment gateways", BNPL: "buy-now-pay-later", APM: "alternative methods (EFT, wallets…)",
};

/** Payment-provider ADOPTION over the last 10 years — a best estimate of when each currently-live
 *  store chose its provider, assuming the choice was made at LAUNCH. Cumulative installed base per
 *  provider = a rising adoption curve. Client-fetched from the cached /api/provider-adoption so it
 *  streams in after the page shell (never blocks the report). */
export function ProviderAdoptionChart({ country, platform }: { country: string; platform: string }) {
  const [data, setData] = useState<Series | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [ptype, setPtype] = useState<string>("all"); // PSP | BNPL | APM | all — filters the lines client-side

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      setLoading(true); setErr(null);
      const p = new URLSearchParams({ country });
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
  }, [country, platform]);

  const years = data?.years ?? [];
  const all = data?.providers ?? [];
  // Filter by gateway type (PSP/BNPL/APM) then take the top 6 WITHIN that type — so the toggle
  // always shows the leaders of the selected type, not just the typed few that made the overall top.
  const provs = (ptype === "all" ? all : all.filter((p) => p.type === ptype)).slice(0, 6);
  const typeCount = (t: string) => (t === "all" ? all.length : all.filter((p) => p.type === t).length);
  const W = 760, H = 300, padL = 44, padR = 96, padB = 34, padT = 16;
  const iw = W - padL - padR, ih = H - padT - padB;
  const maxY = Math.max(1, ...provs.flatMap((p) => p.cumulative));
  const xAt = (i: number) => padL + (years.length > 1 ? (i / (years.length - 1)) * iw : 0);
  const yAt = (v: number) => padT + ih - (v / maxY) * ih;
  const path = (cum: number[]) => cum.map((v, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(" ");
  const yTicks = 4;
  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W - padL;
    const i = Math.round((x / iw) * (years.length - 1));
    setHover(i >= 0 && i < years.length ? i : null);
  };

  return (
    <div className="rounded-[2rem] border border-cream/12 bg-cream/[0.03] p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold">Payment provider adoption — last 10 years</h3>
          <p className="mt-1 text-sm text-cream/45">
            Cumulative merchants per provider, credited to each store&rsquo;s launch year (best estimate of when they chose it).
          </p>
        </div>
        <div className="flex gap-1 rounded-full border border-cream/12 p-1" title="filter by gateway type">
          {TYPES.map(([k, l]) => (
            <button key={k} onClick={() => setPtype(k)} title={TYPE_HINT[k]}
              className={`rounded-full px-3 py-1 text-xs transition ${ptype === k ? "bg-cyan font-semibold text-cyan-deep" : "text-cream/50 hover:text-cream"}`}>
              {l}{data && k !== "all" ? <span className="ml-1 opacity-60">{typeCount(k)}</span> : null}
            </button>
          ))}
        </div>
      </div>

      {/* legend */}
      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-xs">
        {provs.map((p, i) => (
          <span key={p.label} className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: PALETTE[i % PALETTE.length] }} />
            <span className="text-cream/80">{p.label}</span>
            <span className="text-cream/40">{p.total.toLocaleString()}</span>
          </span>
        ))}
      </div>

      <div className="relative mt-4" onMouseLeave={() => setHover(null)}>
        {loading ? (
          <div className="grid h-64 place-items-center text-sm text-cream/40">Loading…</div>
        ) : err ? (
          <div className="grid h-64 place-items-center text-sm text-orange">{err}</div>
        ) : provs.length === 0 ? (
          <div className="grid h-64 place-items-center text-sm text-cream/40">
            {all.length > 0 && ptype !== "all" ? `No ${ptype} providers in this market.` : "No dated launches for this market yet."}
          </div>
        ) : (
          <>
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full" onMouseMove={onMove}>
              {/* y gridlines + labels */}
              {Array.from({ length: yTicks + 1 }, (_, k) => {
                const v = Math.round((maxY / yTicks) * k), y = yAt(v);
                return (
                  <g key={k}>
                    <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="var(--color-cream)" strokeOpacity="0.08" />
                    <text x={padL - 6} y={y + 3} textAnchor="end" fill="var(--color-cream)" fillOpacity="0.4" fontSize="10">{v.toLocaleString()}</text>
                  </g>
                );
              })}
              {/* x labels */}
              {years.map((y, i) => (
                <text key={y} x={xAt(i)} y={H - 12} textAnchor="middle" fill="var(--color-cream)" fillOpacity="0.5" fontSize="11">
                  {i === 0 ? `≤${y}` : `'${String(y).slice(2)}`}
                </text>
              ))}
              {/* hover guide */}
              {hover != null && <line x1={xAt(hover)} y1={padT} x2={xAt(hover)} y2={padT + ih} stroke="var(--color-cream)" strokeOpacity="0.18" />}
              {/* provider lines + end dot + end label */}
              {provs.map((p, i) => {
                const c = PALETTE[i % PALETTE.length];
                const last = p.cumulative.length - 1;
                return (
                  <g key={p.label}>
                    <path d={path(p.cumulative)} fill="none" stroke={c} strokeWidth="2" strokeLinejoin="round"
                      opacity={hover == null ? 0.95 : 0.5} />
                    <circle cx={xAt(last)} cy={yAt(p.cumulative[last])} r="3" fill={c} opacity={hover == null ? 1 : 0.5} />
                    {hover != null && <circle cx={xAt(hover)} cy={yAt(p.cumulative[hover])} r="3.5" fill={c} />}
                  </g>
                );
              })}
            </svg>
            {hover != null && data && (
              <div className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-lg border border-cream/20 bg-ink-deep/95 px-3 py-2 text-xs shadow-xl"
                style={{ left: `${Math.min(84, Math.max(16, (xAt(hover) / W) * 100))}%`, top: 0 }}>
                <div className="font-semibold text-cream">{hover === 0 ? `Launched ${years[0]} or earlier` : `By end of ${years[hover]}`}</div>
                {[...provs].sort((a, b) => b.cumulative[hover] - a.cumulative[hover]).map((p, i) => (
                  <div key={p.label} className="mt-0.5 flex items-center gap-1.5">
                    <span className="inline-block h-2 w-2 rounded-sm" style={{ background: PALETTE[provs.indexOf(p) % PALETTE.length] }} />
                    <span className="text-cream/75">{p.label}</span>
                    <span className="ml-auto pl-3 font-medium text-cream tabular-nums">{p.cumulative[hover].toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <p className="mt-3 text-xs text-cream/35">
        Best estimate: each currently-live store&rsquo;s provider is credited to its real launch year (first product / launched_at),
        assuming the merchant chose it at launch. Survivorship-adjusted (live stores only) and pre-switch-tracking —
        going forward the switch log refines exactly who moved and when.
      </p>
    </div>
  );
}
