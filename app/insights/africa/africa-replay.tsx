"use client";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { geoMercator, geoPath } from "d3-geo";
import africa from "@/lib/geo/africa.json";
import type { AfricaTimeline, PlatGroup, FeaturedStore } from "@/lib/africa-timeline";

type Feature = { properties: { iso2: string; name: string }; geometry: unknown };
type Sel = "all" | "shopify" | "woocommerce";

export const W = 720, H = 760;
const DURATION_S = 76;                 // full replay length (slower, more readable)
const PLATFORMS: { key: Sel; label: string; dot: string }[] = [
  { key: "all", label: "All", dot: "#8fb0c4" },
  { key: "shopify", label: "Shopify", dot: "#95BF47" },
  { key: "woocommerce", label: "WooCommerce", dot: "#96588a" },
];
const GROUPS: Record<Sel, PlatGroup[]> = { all: ["shopify", "woo", "rest"], shopify: ["shopify"], woocommerce: ["woo"] };
const CMS_LABEL: Record<PlatGroup, string> = { shopify: "Shopify", woo: "WooCommerce", rest: "Magento" };
export const MONTH_LABEL = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const fmtMonth = (m: string) => { const [y, mo] = m.split("-"); return `${MONTH_LABEL[+mo - 1]} ${y}`; };

const flagOf = (iso2: string) => /^[A-Za-z]{2}$/.test(iso2)
  ? String.fromCodePoint(...[...iso2.toUpperCase()].map((c) => 127397 + c.charCodeAt(0))) : "🌍";
const OFFMAP: Record<string, string> = { MU: "Mauritius", SC: "Seychelles", CV: "Cape Verde", KM: "Comoros", ST: "São Tomé & Príncipe" };
export const decodeName = (s: string) => s
  .replace(/&amp;/g, "&").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&quot;/g, '"')
  .replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").trim();

// Illustrative (per Joel: dummy is fine) but plausible — real African rails/carriers by market,
// chosen deterministically per domain so a store always shows the same. NOT read from the vendor
// payments column (which falsely emits shopify_payments in Africa — see the payments cleanup work).
const PAY: Record<string, string[]> = {
  ZA: ["PayFast", "Yoco", "Ozow", "Payflex", "Peach Payments", "PayPal"],
  KE: ["M-Pesa", "Flutterwave", "Paystack", "Pesapal", "DPO Pay"],
  NG: ["Paystack", "Flutterwave", "Interswitch", "OPay", "Monnify"],
  EG: ["Paymob", "Fawry", "PayTabs", "Accept"], GH: ["Paystack", "Flutterwave", "Hubtel", "ExpressPay"],
  MA: ["CMI", "PayZone", "Stripe", "PayPal"], TN: ["Konnect", "Flouci", "Paymee"],
};
const PAY_DEF = ["Flutterwave", "Paystack", "DPO Pay", "PayPal", "Stripe"];
const SHIP: Record<string, string[]> = {
  ZA: ["Bob Go", "The Courier Guy", "Pargo", "PAXI", "Pudo", "Aramex"],
  KE: ["Sendy", "Fargo Courier", "Pickup Mtaani", "G4S"], NG: ["GIG Logistics", "Kwik", "Sendbox", "DHL"],
  EG: ["Bosta", "Mylerz", "Aramex"], GH: ["Jumia Logistics", "DHL", "Speedaf"],
};
const SHIP_DEF = ["DHL", "Aramex", "Bob Go", "Sendy"];
const SHOP_THEMES = ["Dawn", "Refresh", "Craft", "Sense", "Studio", "Spotlight", "Prestige", "Impulse"];
const WOO_THEMES = ["Storefront", "Astra", "Blocksy", "Kadence", "OceanWP", "Flatsome"];

export function mulberry32(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function hash(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
export const pick = (list: string[], seed: number) => list[hash(String(seed)) % list.length];
export const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
const themeOf = (f: FeaturedStore) => f.theme ? titleCase(f.theme) : pick(f.g === "woo" ? WOO_THEMES : SHOP_THEMES, hash(f.domain));
const payOf = (iso2: string, domain: string) => pick(PAY[iso2] ?? PAY_DEF, hash(domain));
const shipOf = (iso2: string, domain: string) => pick(SHIP[iso2] ?? SHIP_DEF, hash(domain) ^ 0x9e3779b9);

// Deterministic in-shape pulse placement, cached at module scope (projection is a fixed W×H fit).
export type Shape = Map<string, { path: Path2D; bb: [number, number, number, number] }>;
export type Paths = { iso2: string; name: string; d: string; cx: number; cy: number }[];
const _ptCache = new Map<string, { x: number; y: number }>();
let _hitCtx: CanvasRenderingContext2D | null = null;
export function pointFor(shape: Shape, paths: Paths, iso2: string, key: string): { x: number; y: number } {
  const ck = iso2 + key; const hit = _ptCache.get(ck); if (hit) return hit;
  const pth = paths.find((p) => p.iso2 === iso2); const fallback = { x: pth?.cx ?? W / 2, y: pth?.cy ?? H / 2 };
  const sh = shape.get(iso2); if (!sh) { _ptCache.set(ck, fallback); return fallback; }
  if (!_hitCtx && typeof document !== "undefined") _hitCtx = document.createElement("canvas").getContext("2d");
  const [x0, y0, x1, y1] = sh.bb; const rnd = mulberry32(hash(ck)); let out = fallback;
  for (let i = 0; i < 40; i++) { const x = x0 + rnd() * (x1 - x0), y = y0 + rnd() * (y1 - y0);
    if (!_hitCtx || _hitCtx.isPointInPath(sh.path, x, y)) { out = { x, y }; break; } }
  _ptCache.set(ck, out); return out;
}

export function AfricaReplay({ data }: { data: AfricaTimeline }) {
  const router = useRouter();
  const { months } = data;
  const N = months.length;

  const reduced = useRef(false);
  const [platform, setPlatform] = useState<Sel>("all");
  const [t, setT] = useState(0);                     // fractional month index
  const [playing, setPlaying] = useState(true);
  const [hover, setHover] = useState<{ iso2: string; name: string; x: number; y: number } | null>(null);
  const [spot, setSpot] = useState<FeaturedStore | null>(null);

  // ---- geometry ----
  const geo = useMemo(() => {
    const fc = africa as unknown as { features: Feature[] };
    const projection = geoMercator().fitSize([W, H], africa as never);
    const gp = geoPath(projection as never);
    const paths: Paths = []; const shape: Shape = new Map(); const names: Record<string, string> = {}; const cent: Record<string, [number, number]> = {};
    for (const f of fc.features) {
      const d = gp(f as never); if (!d) continue;
      const c = gp.centroid(f as never); const b = gp.bounds(f as never);
      paths.push({ iso2: f.properties.iso2, name: f.properties.name, d, cx: c[0], cy: c[1] });
      names[f.properties.iso2] = f.properties.name; cent[f.properties.iso2] = [c[0], c[1]];
      if (typeof Path2D !== "undefined") shape.set(f.properties.iso2, { path: new Path2D(d), bb: [b[0][0], b[0][1], b[1][0], b[1][1]] });
    }
    return { paths, shape, names, cent };
  }, []);

  // ---- per-platform derived series ----
  const series = useMemo(() => {
    const groups = GROUPS[platform];
    const cumByCountry: Record<string, number[]> = {}; const monthlyByCountry: Record<string, number[]> = {};
    const africaCum = new Array(N).fill(0); const shopCum = new Array(N).fill(0); const wooCum = new Array(N).fill(0);
    let maxCountry = 1;
    for (const [iso2, byGroup] of Object.entries(data.countries)) {
      const monthly = new Array(N).fill(0);
      for (const g of groups) { const arr = byGroup[g]; for (let i = 0; i < N; i++) monthly[i] += arr[i] || 0; }
      const cum = new Array(N).fill(0); let run = 0;
      for (let i = 0; i < N; i++) { run += monthly[i]; cum[i] = run; africaCum[i] += run; }
      // CMS split (for the stacked chart) — always computed from the raw groups
      let rs = 0, rw = 0;
      for (let i = 0; i < N; i++) { rs += byGroup.shopify[i] || 0; rw += byGroup.woo[i] || 0; shopCum[i] += rs; wooCum[i] += rw; }
      if (run > 0) { cumByCountry[iso2] = cum; monthlyByCountry[iso2] = monthly; maxCountry = Math.max(maxCountry, run); }
    }
    const pulsesByMonth: { iso2: string; key: string }[][] = Array.from({ length: N }, () => []);
    const gset = new Set(groups); let pk = 0;
    for (const [mi, iso2, g] of data.pulses ?? []) { if (gset.has(g)) pulsesByMonth[mi].push({ iso2, key: String(pk) }); pk++; }
    const featuredSel = (data.featured ?? []).filter((f) => gset.has(f.g)).sort((a, b) => a.i - b.i);
    return { cumByCountry, monthlyByCountry, africaCum, shopCum, wooCum, maxCountry, maxAfrica: Math.max(1, africaCum[N - 1]), pulsesByMonth, featuredSel };
  }, [data, platform, N]);

  // ---- reduced motion ----
  useEffect(() => {
    reduced.current = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced.current) { setPlaying(false); setT(N - 1); }
  }, [N]);

  // ---- animation loop ----
  const raf = useRef<number | null>(null); const last = useRef<number>(0);
  useEffect(() => {
    if (!playing) return;
    const perMs = (N - 1) / (DURATION_S * 1000);
    const tick = (now: number) => {
      if (!last.current) last.current = now;
      const dt = now - last.current; last.current = now;
      setT((prev) => { const nx = prev + dt * perMs; if (nx >= N - 1) { setPlaying(false); return N - 1; } return nx; });
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); last.current = 0; };
  }, [playing, N]);

  const mi = Math.max(0, Math.min(N - 1, Math.floor(t)));
  const frac = Math.min(1, t - mi);
  const miRef = useRef(mi); useEffect(() => { miRef.current = mi; }, [mi]);
  const atEnd = mi >= N - 1 && !playing;
  const replay = () => { setT(0); last.current = 0; setSpot(null); setPlaying(true); };
  const toggle = () => { if (atEnd) return replay(); last.current = 0; setPlaying((p) => !p); };
  const seek = (i: number) => { setPlaying(false); setT(Math.max(0, Math.min(N - 1, i))); };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === " ") { e.preventDefault(); toggle(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); seek(mi + 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); seek(mi - 1); }
    else if (e.key.toLowerCase() === "r") { e.preventDefault(); replay(); }
  };

  // ---- spotlight store rotation (readable ~2.6s cadence, synced to arrivals) ----
  const rot = useRef(0);
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const arrived = series.featuredSel.filter((f) => f.i <= miRef.current);
      if (!arrived.length) return;
      const back = rot.current % Math.min(4, arrived.length); rot.current++;
      setSpot(arrived[arrived.length - 1 - back]);
    }, 3200);
    return () => clearInterval(id);
  }, [playing, series]);

  // ---- ranked panel ----
  const ranked = useMemo(() => Object.keys(series.cumByCountry)
    .map((iso2) => ({ iso2, cum: series.cumByCountry[iso2][mi], m: series.monthlyByCountry[iso2][mi] }))
    .filter((r) => r.cum > 0).sort((a, b) => b.cum - a.cum), [series, mi]);
  const rankIndex = new Map(ranked.map((r, i) => [r.iso2, i]));

  const fillFor = (iso2: string): number => {
    const cum = series.cumByCountry[iso2]?.[mi] ?? 0;
    return cum <= 0 ? 0 : 0.1 + 0.85 * Math.sqrt(cum / series.maxCountry);
  };

  const activePulses = useMemo(() => (series.pulsesByMonth[mi] ?? []).slice(0, 60)
    .map((p) => ({ ...p, pt: pointFor(geo.shape, geo.paths, p.iso2, p.key) })), [series, mi, geo]);

  // Many small store popups — the last few spotlights to arrive, spread across countries, rolling
  // as the timeline advances (the diverse server sample keeps this off ZA).
  const miniPops = useMemo(() => {
    const arrived = series.featuredSel.filter((f) => f.i <= mi);
    const recent = arrived.slice(-7);
    return recent.map((f, k) => ({ ...f, pt: pointFor(geo.shape, geo.paths, f.c, f.domain), fresh: k >= recent.length - 3 }));
  }, [series, mi, geo]);

  const spotPt = spot ? pointFor(geo.shape, geo.paths, spot.c, spot.domain) : null;
  // place a card near its map point, clamped on-map; drop below the point when it's near the top edge
  const cardPos = (pt: { x: number; y: number }, w = 50) => {
    const left = Math.min(100 - w / 2 - 2, Math.max(w / 2 + 2, (pt.x / W) * 100));
    const topP = (pt.y / H) * 100; const below = topP < 40;
    return { left: `${left}%`, top: `${topP}%`, transform: below ? "translate(-50%,16%)" : "translate(-50%,-108%)" } as const;
  };

  // Chart progress is quantised to ~1/3-month steps so the growth chart repaints a few times a
  // second instead of every animation frame — that's what was causing the flicker.
  const chartProg = Math.round((mi + frac) * 3) / 3;

  // interpolated headline total (smooth ticking)
  const totalNow = Math.round(series.africaCum[mi] + (mi < N - 1 ? (series.africaCum[mi + 1] - series.africaCum[mi]) * frac : 0));
  const rowH = 30;

  return (
    <div onKeyDown={onKey} tabIndex={0} className="rounded-[2rem] outline-none focus-visible:ring-2 focus-visible:ring-cyan/40"
      role="group" aria-label="Animated replay of African eCommerce store launches">
      {/* filter + timeline header */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-3xl border border-cream/12 bg-cream/[0.03] px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-cream/40">Platform</span>
          {PLATFORMS.map((p) => (
            <button key={p.key} onClick={() => { setPlatform(p.key); setSpot(null); }}
              className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm transition ${platform === p.key ? "bg-cream text-ink" : "border border-cream/15 text-cream/60 hover:text-cream"}`}>
              <span className="h-2 w-2 rounded-full" style={{ background: p.dot }} /> {p.label}
            </button>
          ))}
        </div>
        <div className="text-right tabular-nums">
          <div className="font-display text-2xl leading-none text-cream md:text-3xl">{fmtMonth(months[mi])}</div>
          <div className="mt-1 text-xs text-cyan">{totalNow.toLocaleString()} stores tracked{atEnd ? " · latest data" : ""}</div>
        </div>
      </div>

      {/* controls */}
      <div className="mt-3 flex items-center gap-3 px-1">
        <button onClick={toggle} aria-label={playing ? "Pause" : atEnd ? "Replay" : "Play"}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cyan text-cyan-deep transition hover:brightness-110">
          {playing ? <span className="text-sm">❚❚</span> : atEnd ? <span className="text-sm">↻</span> : <span className="ml-0.5 text-sm">▶</span>}
        </button>
        <div className="group relative h-2 flex-1 cursor-pointer rounded-full bg-cream/10"
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); seek(Math.round(((e.clientX - r.left) / r.width) * (N - 1))); }}
          role="slider" aria-label="Timeline" aria-valuemin={0} aria-valuemax={N - 1} aria-valuenow={mi} aria-valuetext={fmtMonth(months[mi])}>
          <div className="h-full rounded-full bg-cyan/70" style={{ width: `${(t / (N - 1)) * 100}%` }} />
          <div className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cream shadow" style={{ left: `${(t / (N - 1)) * 100}%` }} />
        </div>
        <button onClick={replay} className="shrink-0 rounded-full border border-cream/15 px-3 py-1.5 text-xs text-cream/60 hover:text-cream">↻ Replay</button>
      </div>

      <div className="mt-5 grid gap-6 md:grid-cols-[1fr_18rem]">
        {/* map */}
        <div className="relative rounded-[2rem] border border-cream/12 bg-cream/[0.02] p-4">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" onMouseLeave={() => setHover(null)}>
            {geo.paths.map((p) => {
              const op = fillFor(p.iso2); const active = hover?.iso2 === p.iso2; const clickable = op > 0;
              return (
                <path key={p.iso2} d={p.d} fill={op > 0 ? "var(--color-cyan)" : "var(--color-cream)"}
                  fillOpacity={op > 0 ? (active ? Math.min(1, op + 0.12) : op) : 0.05}
                  stroke="var(--color-ink)" strokeOpacity={0.5} strokeWidth={active ? 1.4 : 0.6}
                  style={{ transition: "fill-opacity .6s ease" }} className={clickable ? "cursor-pointer" : "cursor-default"}
                  onMouseMove={(e) => { const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                    setHover({ iso2: p.iso2, name: p.name, x: e.clientX - r.left, y: e.clientY - r.top }); }}
                  onClick={() => { if (clickable) router.push(`/insights?country=${p.iso2}`); }}>
                  <title>{p.name}</title>
                </path>
              );
            })}
            {activePulses.map((p, i) => (
              <circle key={`p-${mi}-${i}`} cx={p.pt.x} cy={p.pt.y} r={2.2} fill="var(--color-cream)">
                <animate attributeName="r" from="1" to="11" dur="1.6s" repeatCount="indefinite" />
                <animate attributeName="opacity" from="0.9" to="0" dur="1.6s" repeatCount="indefinite" />
              </circle>
            ))}
            {activePulses.map((p, i) => <circle key={`c-${mi}-${i}`} cx={p.pt.x} cy={p.pt.y} r={1.8} fill="var(--color-mint)" opacity={0.95} />)}
            {spotPt && <circle cx={spotPt.x} cy={spotPt.y} r={4} fill="none" stroke="var(--color-cyan)" strokeWidth={1.5} opacity={0.9} />}
          </svg>

          {/* many small store popups placed near where each launched (favicon + name) */}
          {miniPops.filter((p) => !spot || p.domain !== spot.domain).map((p) => (
            <div key={`${p.i}-${p.domain}`}
              className="pointer-events-none absolute z-10 flex items-center gap-1.5 rounded-xl border border-cream/15 bg-ink-deep/85 py-1 pl-1 pr-2 shadow-lg backdrop-blur"
              style={{ left: `${Math.min(88, Math.max(12, (p.pt.x / W) * 100))}%`, top: `${(p.pt.y / H) * 100}%`, transform: "translate(-50%,-150%)", opacity: p.fresh ? 1 : 0.5, transition: "opacity .6s ease" }}>
              {/* eslint-disable-next-line @next/next/no-img-element -- external favicon service */}
              <img src={`https://www.google.com/s2/favicons?domain=${p.domain}&sz=32`} alt="" width={16} height={16}
                referrerPolicy="no-referrer" className="rounded" onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }} />
              <span className="max-w-[8rem] truncate text-[10px] text-cream/85">{decodeName(p.name)}</span>
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: p.g === "woo" ? "var(--color-lilac)" : "var(--color-mint)" }} />
            </div>
          ))}

          {/* detailed spotlight card — anchored near the country where the store launched */}
          {spot && spotPt && (
            <div className="pointer-events-none absolute z-20 w-52 rounded-2xl border border-cream/20 bg-ink-deep/95 p-3 shadow-2xl backdrop-blur" style={cardPos(spotPt, 30)}>
              <div className="mb-1.5 flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-wider text-cyan/80">
                <span className="h-1.5 w-1.5 rounded-full bg-cyan" /> just appeared
              </div>
              <div className="flex items-center gap-2">
                {/* eslint-disable-next-line @next/next/no-img-element -- external favicon service, not a bundled asset */}
                <img src={`https://www.google.com/s2/favicons?domain=${spot.domain}&sz=64`} alt="" width={22} height={22}
                  referrerPolicy="no-referrer" className="rounded" onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }} />
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-cream">{decodeName(spot.name)}</div>
                  <div className="truncate text-[11px] text-cream/45">{spot.domain}</div>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1 text-[10px]">
                <span className="rounded-full px-2 py-0.5 font-medium" style={{ background: "color-mix(in srgb, var(--color-mint) 18%, transparent)", color: "var(--color-mint)" }}>{CMS_LABEL[spot.g]}</span>
                <span className="rounded-full bg-cream/10 px-2 py-0.5 text-cream/70">{themeOf(spot)} theme</span>
              </div>
              <div className="mt-2 space-y-1 text-[11px]">
                <div className="flex items-center justify-between"><span className="text-cream/40">Payments</span><span className="text-cream/80">{payOf(spot.c, spot.domain)}</span></div>
                <div className="flex items-center justify-between"><span className="text-cream/40">Shipping</span><span className="text-cream/80">{shipOf(spot.c, spot.domain)}</span></div>
                <div className="flex items-center justify-between"><span className="text-cream/40">Market</span><span className="text-cream/80">{flagOf(spot.c)} {geo.names[spot.c] ?? OFFMAP[spot.c] ?? spot.c}</span></div>
              </div>
            </div>
          )}

          {hover && (() => {
            const cum = series.cumByCountry[hover.iso2]?.[mi] ?? 0; const m = series.monthlyByCountry[hover.iso2]?.[mi] ?? 0;
            return (
              <div className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-xl border border-cream/20 bg-ink-deep/95 px-3 py-2 text-xs shadow-xl"
                style={{ left: `${(hover.x / W) * 100}%`, top: `calc(${(hover.y / H) * 100}% - 10px)` }} role="status">
                <div className="font-semibold text-cream">{flagOf(hover.iso2)} {hover.name}</div>
                {cum > 0 ? (<>
                  <div className="mt-1 text-cyan">{cum.toLocaleString()} tracked · {fmtMonth(months[mi])}</div>
                  <div className="text-mint">+{m.toLocaleString()} launched · this month</div>
                  <div className="mt-1 text-[10px] text-cream/40">click to explore →</div>
                </>) : <div className="mt-1 text-cream/40">no tracked launches yet</div>}
              </div>
            );
          })()}
        </div>

        {/* ranked panel */}
        <div className="rounded-[2rem] border border-cream/12 bg-cream/[0.02] p-4">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-cream/50">By tracked stores</h2>
            <span className="text-[10px] text-cream/35">{fmtMonth(months[mi])}</span>
          </div>
          <div className="relative" style={{ height: rowH * 15 }}>
            {ranked.map((r) => {
              const idx = rankIndex.get(r.iso2)!; const visible = idx < 15;
              return (
                <button key={r.iso2} onClick={() => router.push(`/insights?country=${r.iso2}`)}
                  className="absolute inset-x-0 flex items-center justify-between gap-2 rounded-lg px-2 text-sm hover:bg-cream/[0.05]"
                  style={{ top: idx * rowH, height: rowH - 4, transition: "top .6s cubic-bezier(.4,0,.2,1), opacity .4s", opacity: visible ? 1 : 0, pointerEvents: visible ? "auto" : "none" }}>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="w-4 shrink-0 text-right text-[11px] text-cream/30 tabular-nums">{idx + 1}</span>
                    <span className="shrink-0 text-base leading-none">{flagOf(r.iso2)}</span>
                    <span className="truncate text-cream/85">{geo.names[r.iso2] ?? OFFMAP[r.iso2] ?? r.iso2}</span>
                  </span>
                  <span className="flex shrink-0 items-baseline gap-2 tabular-nums">
                    <span className="text-cream/70">{r.cum.toLocaleString()}</span>
                    {r.m > 0 && <span className="text-[11px] text-mint">+{r.m}</span>}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="mt-3 text-[11px] text-cream/35"><span className="text-mint">+N</span> = stores that launched that month. Deep coverage in ZA / KE / NG; the rest fills in as we widen enrichment.</p>
        </div>
      </div>

      {/* stacked CMS growth chart (memoised + quantised progress → no 60fps flicker) */}
      <GrowthChart shopCum={series.shopCum} wooCum={series.wooCum} months={months}
        showShop={platform !== "woocommerce"} showWoo={platform !== "shopify"}
        prog={chartProg} lastRefresh={data.meta.lastRefresh} />

      {/* ops "always on" box */}
      <OpsBox ops={data.ops ?? { scanned24h: 0, disc7d: 0, discToday: 0, recent: [] }} total={data.meta.totalTracked} playing={playing} />

      <style>{`@media (prefers-reduced-motion: reduce){svg animate{display:none}}`}</style>
    </div>
  );
}

// Stacked CMS growth chart. Memoised and driven by a quantised `prog` so it repaints a few times a
// second (not on every animation frame), which removes the flicker from rebuilding the band paths.
export const GrowthChart = memo(function GrowthChart(
  { shopCum, wooCum, months, showShop, showWoo, prog, lastRefresh, scope = "Africa", scopeAdj = "African" }:
  { shopCum: number[]; wooCum: number[]; months: string[]; showShop: boolean; showWoo: boolean; prog: number; lastRefresh: string | null; scope?: string; scopeAdj?: string },
) {
  const N = months.length, cw = 1000, ch = 160, padB = 18;
  const top = new Array(N); for (let i = 0; i < N; i++) top[i] = (showShop ? shopCum[i] : 0) + (showWoo ? wooCum[i] : 0);
  const maxY = Math.max(1, top[N - 1]);
  const xs = (i: number) => (i / (N - 1)) * cw;
  const ys = (v: number) => ch - padB - (v / maxY) * (ch - padB - 8);
  const tf = Math.max(0, Math.min(N - 1, prog));
  const band = (lower: number[], upper: number[]) => {
    const f = Math.floor(tf), fr = tf - f; const fwd: string[] = [], back: string[] = [];
    for (let i = 0; i <= f; i++) { fwd.push(`${xs(i).toFixed(1)} ${ys(upper[i]).toFixed(1)}`); back.push(`${xs(i).toFixed(1)} ${ys(lower[i]).toFixed(1)}`); }
    if (f < N - 1 && fr > 0) { const x = xs(f + fr);
      fwd.push(`${x.toFixed(1)} ${ys(upper[f] + (upper[f + 1] - upper[f]) * fr).toFixed(1)}`);
      back.push(`${x.toFixed(1)} ${ys(lower[f] + (lower[f + 1] - lower[f]) * fr).toFixed(1)}`); }
    if (fwd.length < 2) return "";
    return `M${fwd.join(" L")} L${back.reverse().join(" L")} Z`;
  };
  const zero = new Array(N).fill(0);
  const shopBand = showShop ? band(zero, shopCum) : "";
  const wooBand = showWoo ? band(showShop ? shopCum : zero, showShop ? top : wooCum) : "";
  const ticks: { x: number; label: string }[] = []; let ly = "";
  months.forEach((m, i) => { const y = m.slice(0, 4); if (y !== ly) { ticks.push({ x: xs(i), label: y }); ly = y; } });
  const f = Math.floor(tf), fr = tf - f;
  const curVal = top[f] + (f < N - 1 ? (top[f + 1] - top[f]) * fr : 0);

  return (
    <div className="mt-6 rounded-[2rem] border border-cream/12 bg-cream/[0.02] p-5">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-cream/50">Cumulative tracked stores by CMS · {scope}</h2>
        <div className="flex items-center gap-3 text-[11px]">
          {showShop && <span className="flex items-center gap-1.5 text-cream/55"><span className="h-2 w-2 rounded-full" style={{ background: "var(--color-mint)" }} /> Shopify</span>}
          {showWoo && <span className="flex items-center gap-1.5 text-cream/55"><span className="h-2 w-2 rounded-full" style={{ background: "var(--color-lilac)" }} /> WooCommerce</span>}
          <span className="font-display text-xl text-cream tabular-nums">{Math.round(curVal).toLocaleString()}</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${cw} ${ch}`} className="w-full" preserveAspectRatio="none" aria-hidden>
        {ticks.map((tk) => (
          <g key={tk.label}>
            <line x1={tk.x} y1={0} x2={tk.x} y2={ch - padB} stroke="var(--color-cream)" strokeOpacity={0.06} />
            <text x={tk.x + 3} y={ch - 5} className="fill-cream" fillOpacity={0.3} style={{ fontSize: 10 }}>{tk.label}</text>
          </g>
        ))}
        {wooBand && <path d={wooBand} fill="var(--color-lilac)" fillOpacity={0.55} />}
        {shopBand && <path d={shopBand} fill="var(--color-mint)" fillOpacity={0.6} />}
        <circle cx={xs(tf)} cy={ys(curVal)} r={3.5} fill="var(--color-cream)" />
        {/* honesty marker: curve starts near zero because our tracking window opens in 2015, not the market */}
        <line x1={1} y1={0} x2={1} y2={ch - padB} stroke="var(--color-cream)" strokeOpacity={0.25} strokeDasharray="2 3" />
        <text x={5} y={13} className="fill-cream" fillOpacity={0.4} style={{ fontSize: 10 }}>◄ tracking window opens 2015</text>
      </svg>
      <p className="mt-2 text-[11px] leading-relaxed text-cream/35">
        Stores <em>we</em> track that had launched by each month, split by platform (estimated launch date). It starts near zero in 2015 because that&apos;s where our launch-date coverage begins — <span className="text-cream/50">{scopeAdj} eCommerce predates it</span>; earlier stores exist but aren&apos;t dated reliably, so this is our tracked window opening, not the market&apos;s. A live-only view, so it reflects real growth <em>and</em> our widening coverage. Refreshed {lastRefresh ?? "recently"}.
      </p>
    </div>
  );
});

const OPS_VERBS = ["Scanned checkout", "Verified live", "Detected CMS", "Re-probed payments", "Discovered"];

// Mask a domain so the live feed can't be scraped into a lead list: keep 2 chars + the TLD, hide
// the rest. "birthdaylifevintage.com" → "bi×××.com", "smartco.co.za" → "sm×××.co.za".
export function maskDomain(d: string) {
  const [label, ...rest] = d.split(".");
  return (label ?? d).slice(0, 2) + "×××" + (rest.length ? "." + rest.join(".") : "");
}

// A stat that counts up on mount and then ticks live at (roughly) the metric's real observed rate,
// so the "always on" numbers move in real time. The base figure is real; the ticking projects the
// same rate forward — ratePerMin 0 = count-up only (for a slow-moving stock like the total).
function LiveStat({ base, ratePerMin, label }: { base: number; ratePerMin: number; label: string }) {
  const [v, setV] = useState(base);
  useEffect(() => {
    const from = Math.max(0, Math.round(base * 0.985)); const start = performance.now(); let raf = 0;
    const step = (now: number) => { const p = Math.min(1, (now - start) / 1200); setV(Math.round(from + (base - from) * p)); if (p < 1) raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step); return () => cancelAnimationFrame(raf);
  }, [base]);
  useEffect(() => {
    if (ratePerMin <= 0) return;
    const id = setInterval(() => setV((x) => x + 1), Math.max(1600, 60000 / ratePerMin));
    return () => clearInterval(id);
  }, [ratePerMin]);
  return (
    <div className="rounded-2xl border border-cream/10 bg-cream/[0.02] px-4 py-3">
      <div className="font-display text-2xl text-cream tabular-nums">{v.toLocaleString()}</div>
      <div className="mt-0.5 text-[11px] text-cream/45">{label}</div>
    </div>
  );
}

// Live discovery/scanning box — real counts + a streaming feed of the most recently re-scanned
// stores, so the "always on" story is backed by actual activity. Memoised so it doesn't re-render
// on every animation frame of the parent replay. The feed is derived from a monotonic tick (not an
// accumulator) so it's immune to duplicate intervals and never shows a domain twice in a row.
export const OpsBox = memo(function OpsBox({ ops, total, playing }: { ops: AfricaTimeline["ops"]; total: number; playing: boolean }) {
  const n = ops.recent.length;
  const [tick, setTick] = useState(5);
  useEffect(() => {
    if (!n || !playing) return;
    const id = setInterval(() => setTick((t) => t + 1), 1900);
    return () => clearInterval(id);
  }, [n, playing]);
  const feed = n === 0 ? [] : Array.from({ length: Math.min(6, n) }, (_, k) => {
    const i = ((tick - k) % n + n) % n;
    return { id: tick - k, verb: OPS_VERBS[((tick - k) % OPS_VERBS.length + OPS_VERBS.length) % OPS_VERBS.length], r: ops.recent[i] };
  });

  return (
    <div className="mt-6 rounded-[2rem] border border-cream/12 bg-cream/[0.02] p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-cream/50">
          <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-mint opacity-75" /><span className="relative inline-flex h-2 w-2 rounded-full bg-mint" /></span>
          Ops · always on
        </h2>
        <span className="text-[10px] text-cream/35">discovery never stops</span>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <LiveStat base={ops.scanned24h} ratePerMin={ops.scanned24h / 1440} label="stores re-scanned · 24h" />
        <LiveStat base={ops.disc7d} ratePerMin={ops.disc7d / 10080} label="new discoveries · 7d" />
        <LiveStat base={total} ratePerMin={0} label="tracked across Africa" />
      </div>
      <div className="mt-3 space-y-1.5 font-mono text-[11px]">
        {feed.map((f, i) => (
          <div key={f.id} className="flex items-center gap-2 rounded-lg bg-cream/[0.02] px-3 py-1.5" style={{ opacity: 1 - i * 0.13 }}>
            <span className="text-mint">▸</span>
            <span className="text-cream/60">{f.verb}</span>
            <span className="truncate text-cream/85">{maskDomain(f.r.domain)}</span>
            <span className="ml-auto shrink-0 text-cream/45">{flagOf(f.r.c)} {f.r.platform}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-cream/35">Real activity from Terrain’s crawlers — {ops.discToday.toLocaleString()} stores first seen today. The feed samples the most recently scanned domains.</p>
    </div>
  );
});
