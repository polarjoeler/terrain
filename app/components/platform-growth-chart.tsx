"use client";

import { useEffect, useMemo, useState, type MouseEvent } from "react";

type Status = { selling: number; active: number; dormant: number; other: number; total: number };
type Point = { date: string; shopify: number; woo: number };
type Data = {
  points: Point[]; shopifyNow: number; wooNow: number;
  shopifyStatus: Status; wooStatus: Status; since: string;
};

const SHOP = "#95BF47", WOO = "#96588a";
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtMonth = (iso: string) => { const [y, m] = iso.split("-").map(Number); return `${MON[m - 1]} '${String(y).slice(2)}`; };

/** Cumulative platform-growth chart for the combined view — two lines (Shopify vs WooCommerce)
 *  showing how each platform's live base has grown by launch cohort, so a viewer can see which is
 *  growing faster. Legend chips reveal the current selling/active/dormant split on hover (the Woo
 *  breakdown the user asked for; Shopify shows a paid-vs-rest split, its nearest equivalent).
 *  Renders only on the "all" platform view. Fetches paid-gated /api/platform-growth. */
export function PlatformGrowthChart({ country }: { country?: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [legend, setLegend] = useState<null | "shopify" | "woo">(null);

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      setLoading(true); setErr(null);
      const p = new URLSearchParams();
      if (country) p.set("country", country);
      try {
        const r = await fetch(`/api/platform-growth?${p.toString()}`, { signal: ac.signal });
        if (!r.ok) throw new Error(r.status === 403 ? "Subscribers only" : "Couldn't load");
        setData(await r.json());
      } catch (e) {
        if ((e as Error).name !== "AbortError") setErr((e as Error).message);
      } finally { setLoading(false); }
    })();
    return () => ac.abort();
  }, [country]);

  const pts = useMemo(() => data?.points ?? [], [data]);
  // A platform gets a trajectory line only if we have launch dates for ENOUGH of its live base for
  // the cohort curve to be representative (final cumulative ≥ 20% of the current live total). Woo
  // launch-dating is still being built (BuiltWith gave us discovery, not birth dates), so it falls
  // below that bar — drawing its handful of dated stores would sit flat at zero and mislead. Omit
  // the line and lean on the chip total + status split instead.
  const last = pts.length ? pts[pts.length - 1] : null;
  const cover = (cum: number, now?: number) => (now && now > 0 ? cum / now : 0);
  const shopHasData = pts.length > 1 && cover(last?.shopify ?? 0, data?.shopifyNow) >= 0.2;
  const wooHasData = pts.length > 1 && cover(last?.woo ?? 0, data?.wooNow) >= 0.2;
  const W = 760, H = 280, padL = 46, padR = 16, padB = 34, padT = 16;
  const iw = W - padL - padR, ih = H - padT - padB;
  const max = Math.max(1, ...pts.map((p) => Math.max(shopHasData ? p.shopify : 0, wooHasData ? p.woo : 0)));
  const stepX = pts.length > 1 ? iw / (pts.length - 1) : iw;
  const xAt = (i: number) => padL + i * stepX;
  const yAt = (v: number) => padT + ih - (v / max) * ih;
  const path = (key: "shopify" | "woo") =>
    pts.map((p, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(p[key]).toFixed(1)}`).join(" ");
  const area = (key: "shopify" | "woo") =>
    pts.length ? `${path(key)} L${xAt(pts.length - 1).toFixed(1)},${padT + ih} L${xAt(0).toFixed(1)},${padT + ih} Z` : "";
  const labelEvery = Math.max(1, Math.ceil(pts.length / 8));

  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round((((e.clientX - r.left) / r.width) * W - padL) / stepX);
    setHover(i >= 0 && i < pts.length ? i : null);
  };
  const hp = hover != null ? pts[hover] : null;

  const StatusPop = ({ s, kind }: { s: Status; kind: "shopify" | "woo" }) => (
    <div className="absolute bottom-full right-0 z-20 mb-2 w-52 rounded-xl border border-cream/20 bg-ink-deep/95 p-3 text-xs shadow-xl">
      <div className="mb-1.5 font-semibold" style={{ color: kind === "shopify" ? SHOP : WOO }}>
        {kind === "shopify" ? "Shopify" : "WooCommerce"} · {s.total.toLocaleString()} live
      </div>
      {kind === "woo" ? (
        <ul className="space-y-1">
          <li className="flex justify-between"><span className="text-cream/60">Selling (has sales/reviews)</span><span className="tabular-nums text-mint">{s.selling.toLocaleString()}</span></li>
          <li className="flex justify-between"><span className="text-cream/60">Active (live, stocked)</span><span className="tabular-nums text-cyan">{s.active.toLocaleString()}</span></li>
          <li className="flex justify-between"><span className="text-cream/60">Dormant (built, idle)</span><span className="tabular-nums text-orange">{s.dormant.toLocaleString()}</span></li>
          {s.other > 0 && <li className="flex justify-between"><span className="text-cream/60">Parked / other</span><span className="tabular-nums text-cream/50">{s.other.toLocaleString()}</span></li>}
        </ul>
      ) : (
        <ul className="space-y-1">
          <li className="flex justify-between"><span className="text-cream/60">Selling (payment-verified)</span><span className="tabular-nums text-mint">{s.selling.toLocaleString()}</span></li>
          <li className="flex justify-between"><span className="text-cream/60">Other live</span><span className="tabular-nums text-cyan">{s.active.toLocaleString()}</span></li>
        </ul>
      )}
    </div>
  );

  return (
    <div className="rounded-[2rem] border border-cream/12 bg-cream/[0.03] p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold">Platform growth · Shopify vs WooCommerce</h3>
          <p className="mt-1 text-sm text-cream/45">Cumulative live stores by launch cohort — who&rsquo;s growing faster.</p>
        </div>
        {/* legend chips — hover to reveal each platform's live-status split */}
        <div className="flex gap-2">
          {([["shopify", "Shopify", SHOP, data?.shopifyNow, data?.shopifyStatus], ["woo", "WooCommerce", WOO, data?.wooNow, data?.wooStatus]] as const).map(
            ([key, label, color, now, status]) => (
              <div key={key} className="relative" onMouseEnter={() => setLegend(key)} onMouseLeave={() => setLegend(null)}>
                <button className="flex items-center gap-1.5 rounded-full border border-cream/12 px-3 py-1.5 text-xs text-cream/75 hover:border-cream/30">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
                  {label}
                  <span className="tabular-nums text-cream/50">{now != null ? now.toLocaleString() : "—"}</span>
                </button>
                {legend === key && status && <StatusPop s={status} kind={key} />}
              </div>
            ),
          )}
        </div>
      </div>

      <div className="relative mt-5" onMouseLeave={() => setHover(null)}>
        {loading ? (
          <div className="grid h-64 place-items-center text-sm text-cream/40">Loading…</div>
        ) : err ? (
          <div className="grid h-64 place-items-center text-sm text-orange">{err}</div>
        ) : !shopHasData && !wooHasData ? (
          <div className="grid h-64 place-items-center text-sm text-cream/40">Not enough dated stores yet to chart growth.</div>
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
                <linearGradient id="pgShop" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={SHOP} stopOpacity="0.22" /><stop offset="1" stopColor={SHOP} stopOpacity="0" /></linearGradient>
                <linearGradient id="pgWoo" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={WOO} stopOpacity="0.22" /><stop offset="1" stopColor={WOO} stopOpacity="0" /></linearGradient>
              </defs>
              {shopHasData && <path d={area("shopify")} fill="url(#pgShop)" />}
              {wooHasData && <path d={area("woo")} fill="url(#pgWoo)" />}
              {shopHasData && <path d={path("shopify")} fill="none" stroke={SHOP} strokeWidth="2.5" strokeLinejoin="round" />}
              {wooHasData && <path d={path("woo")} fill="none" stroke={WOO} strokeWidth="2.5" strokeLinejoin="round" />}
              {/* hover guide + dots */}
              {hover != null && (
                <>
                  <line x1={xAt(hover)} y1={padT} x2={xAt(hover)} y2={padT + ih} stroke="var(--color-cream)" strokeOpacity="0.25" />
                  {shopHasData && <circle cx={xAt(hover)} cy={yAt(pts[hover].shopify)} r="3.5" fill={SHOP} />}
                  {wooHasData && <circle cx={xAt(hover)} cy={yAt(pts[hover].woo)} r="3.5" fill={WOO} />}
                </>
              )}
              {/* x labels */}
              {pts.map((p, i) => (i % labelEvery === 0 ? (
                <text key={p.date} x={xAt(i)} y={H - 12} textAnchor="middle" fill="var(--color-cream)" fillOpacity="0.55" fontSize="11">{fmtMonth(p.date)}</text>
              ) : null))}
            </svg>
            {hp && (
              <div className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-lg border border-cream/20 bg-ink-deep/95 px-3 py-2 text-xs shadow-xl"
                style={{ left: `${Math.min(84, Math.max(16, (xAt(hover ?? 0) / W) * 100))}%`, top: 0 }}>
                <div className="font-semibold text-cream">{fmtMonth(hp.date)}</div>
                {shopHasData && <div className="mt-1" style={{ color: SHOP }}>{hp.shopify.toLocaleString()} Shopify</div>}
                {wooHasData && <div style={{ color: WOO }}>{hp.woo.toLocaleString()} WooCommerce</div>}
              </div>
            )}
          </>
        )}
      </div>

      <p className="mt-3 text-xs text-cream/35">
        Cumulative count of currently-live stores by their real launch month (dated stores, from {data?.since?.slice(0, 4) ?? "2022"} on) — a clean growth trajectory, not the exact base. Hover a legend chip for the live selling/active/dormant split.
        {data && !wooHasData && <span className="text-orange/70"> WooCommerce launch-dating is still being built, so only its current total &amp; status split show for now — the Shopify trajectory is live.</span>}
      </p>
    </div>
  );
}
