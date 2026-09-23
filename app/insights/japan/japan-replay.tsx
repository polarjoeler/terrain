"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { geoMercator, geoPath } from "d3-geo";
import japan from "@/lib/geo/japan.json";
import type { JapanTimeline, PlatGroup, FeaturedStore } from "@/lib/japan-timeline";
import { JP_REGIONS, type JpRegion } from "@/lib/japan-regions";
import {
  W, H, fmtMonth, decodeName, hash, pick, titleCase, pointFor, GrowthChart, OpsBox, type Shape, type Paths,
} from "@/app/insights/africa/africa-replay";

type JFeature = { properties: { pref: string; pref_ja: string; region: JpRegion }; geometry: unknown };
type Sel = "all" | "shopify" | "woocommerce";
const DURATION_S = 76;
const PLATFORMS: { key: Sel; label: string; dot: string }[] = [
  { key: "all", label: "All", dot: "#8fb0c4" }, { key: "shopify", label: "Shopify", dot: "#95BF47" }, { key: "woocommerce", label: "WooCommerce", dot: "#96588a" },
];
const GROUPS: Record<Sel, PlatGroup[]> = { all: ["shopify", "woo", "rest"], shopify: ["shopify"], woocommerce: ["woo"] };
const CMS_LABEL: Record<PlatGroup, string> = { shopify: "Shopify", woo: "WooCommerce", rest: "Other CMS" };
const REGION_JA: Record<JpRegion, string> = { Hokkaido: "北海道", Tohoku: "東北", Kanto: "関東", Chubu: "中部", Kansai: "関西", Chugoku: "中国", Shikoku: "四国", Kyushu: "九州" };

// Illustrative (dummy, per Joel) but realistic Japanese rails/carriers, deterministic per domain.
const JP_PAY = ["Credit card", "PayPay", "Amazon Pay", "Rakuten Pay", "LINE Pay", "Konbini", "Apple Pay", "Merpay"];
const JP_SHIP = ["Yamato (Kuroneko)", "Sagawa Express", "Japan Post · Yū-Pack", "Seino", "Nekopos"];
const SHOP_THEMES = ["Dawn", "Refresh", "Craft", "Sense", "Studio", "Spotlight", "Prestige", "Impulse"];
const themeOf = (f: FeaturedStore) => f.theme ? titleCase(f.theme) : pick(SHOP_THEMES, hash(f.domain));

function shade(v: number, max: number): number { return v <= 0 ? 0 : 0.1 + 0.85 * Math.sqrt(v / max); }

export function JapanReplay({ data }: { data: JapanTimeline }) {
  const router = useRouter();
  const { months } = data;
  const N = months.length;

  const reduced = useRef(false);
  const [platform, setPlatform] = useState<Sel>("all");
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [hover, setHover] = useState<{ region: JpRegion; x: number; y: number } | null>(null);
  const [spot, setSpot] = useState<FeaturedStore | null>(null);

  // ---- geometry: prefectures, grouped by region ----
  const geo = useMemo(() => {
    const fc = japan as unknown as { features: JFeature[] };
    const projection = geoMercator().fitSize([W, H], japan as never);
    const gp = geoPath(projection as never);
    const paths: (Paths[number] & { region: JpRegion })[] = []; const shape: Shape = new Map();
    const regionPrefs: Record<string, string[]> = {}; const acc: Record<string, [number, number, number]> = {};
    for (const f of fc.features) {
      const d = gp(f as never); if (!d) continue;
      const c = gp.centroid(f as never); const b = gp.bounds(f as never); const { pref, region } = f.properties;
      paths.push({ iso2: pref, name: pref, region, d, cx: c[0], cy: c[1] });
      shape.set(pref, { path: new Path2D(d), bb: [b[0][0], b[0][1], b[1][0], b[1][1]] });
      (regionPrefs[region] ??= []).push(pref);
      const a = acc[region] ??= [0, 0, 0]; a[0] += c[0]; a[1] += c[1]; a[2]++;
    }
    const cent: Record<string, [number, number]> = {};
    for (const r in acc) cent[r] = [acc[r][0] / acc[r][2], acc[r][1] / acc[r][2]];
    return { paths, shape, regionPrefs, cent };
  }, []);
  const pointForRegion = (region: JpRegion, key: string) => {
    const prefs = geo.regionPrefs[region]; if (!prefs?.length) return geo.cent[region] ? { x: geo.cent[region][0], y: geo.cent[region][1] } : { x: W / 2, y: H / 2 };
    return pointFor(geo.shape, geo.paths, prefs[hash(key) % prefs.length], region + key);
  };

  // ---- per-platform derived series (by region) ----
  const series = useMemo(() => {
    const groups = GROUPS[platform];
    const cumByRegion: Record<string, number[]> = {}; const monthlyByRegion: Record<string, number[]> = {};
    const shopCum = new Array(N).fill(0); const wooCum = new Array(N).fill(0);
    let maxRegion = 1;
    for (const region of JP_REGIONS) {
      const byGroup = data.regions[region]; const monthly = new Array(N).fill(0);
      for (const g of groups) for (let i = 0; i < N; i++) monthly[i] += byGroup[g][i] || 0;
      const cum = new Array(N).fill(0); let run = 0;
      for (let i = 0; i < N; i++) { run += monthly[i]; cum[i] = run; }
      let rs = 0, rw = 0;
      for (let i = 0; i < N; i++) { rs += byGroup.shopify[i] || 0; rw += byGroup.woo[i] || 0; shopCum[i] += rs; wooCum[i] += rw; }
      cumByRegion[region] = cum; monthlyByRegion[region] = monthly; maxRegion = Math.max(maxRegion, run);
    }
    const totalCum = new Array(N).fill(0); for (const r of JP_REGIONS) for (let i = 0; i < N; i++) totalCum[i] += cumByRegion[r][i];
    const pulsesByMonth: { region: JpRegion; key: string }[][] = Array.from({ length: N }, () => []);
    const gset = new Set(groups); let pk = 0;
    for (const [mi, region, g] of data.pulses ?? []) { if (gset.has(g)) pulsesByMonth[mi].push({ region, key: String(pk) }); pk++; }
    const featuredSel = (data.featured ?? []).filter((f) => gset.has(f.g)).sort((a, b) => a.i - b.i);
    return { cumByRegion, monthlyByRegion, shopCum, wooCum, totalCum, maxRegion, maxTotal: Math.max(1, totalCum[N - 1]), pulsesByMonth, featuredSel };
  }, [data, platform, N]);

  useEffect(() => {
    reduced.current = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced.current) { setPlaying(false); setT(N - 1); }
  }, [N]);

  const raf = useRef<number | null>(null); const last = useRef<number>(0);
  useEffect(() => {
    if (!playing) return;
    const perMs = (N - 1) / (DURATION_S * 1000);
    const tick = (now: number) => {
      if (!last.current) last.current = now; const dt = now - last.current; last.current = now;
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
    if (e.key === " ") { e.preventDefault(); toggle(); } else if (e.key === "ArrowRight") { e.preventDefault(); seek(mi + 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); seek(mi - 1); } else if (e.key.toLowerCase() === "r") { e.preventDefault(); replay(); }
  };

  const rot = useRef(0);
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const arrived = series.featuredSel.filter((f) => f.i <= miRef.current); if (!arrived.length) return;
      const back = rot.current % Math.min(4, arrived.length); rot.current++; setSpot(arrived[arrived.length - 1 - back]);
    }, 3200);
    return () => clearInterval(id);
  }, [playing, series]);

  const ranked = useMemo(() => JP_REGIONS
    .map((region) => ({ region, cum: series.cumByRegion[region][mi], m: series.monthlyByRegion[region][mi] }))
    .filter((r) => r.cum > 0).sort((a, b) => b.cum - a.cum), [series, mi]);
  const rankIndex = new Map(ranked.map((r, i) => [r.region, i]));

  const activePulses = useMemo(() => (series.pulsesByMonth[mi] ?? []).slice(0, 60)
    .map((p) => ({ ...p, pt: pointForRegion(p.region, p.key) })), [series, mi, geo]); // eslint-disable-line react-hooks/exhaustive-deps

  const miniPops = useMemo(() => {
    const recent = series.featuredSel.filter((f) => f.i <= mi).slice(-7);
    return recent.map((f, k) => ({ ...f, pt: pointForRegion(f.r, f.domain), fresh: k >= recent.length - 3 }));
  }, [series, mi, geo]); // eslint-disable-line react-hooks/exhaustive-deps

  const spotPt = spot ? pointForRegion(spot.r, spot.domain) : null;
  const cardPos = (pt: { x: number; y: number }, w = 30) => {
    const left = Math.min(100 - w / 2 - 2, Math.max(w / 2 + 2, (pt.x / W) * 100));
    const topP = (pt.y / H) * 100; const below = topP < 40;
    return { left: `${left}%`, top: `${topP}%`, transform: below ? "translate(-50%,16%)" : "translate(-50%,-108%)" } as const;
  };
  const chartProg = Math.round((mi + frac) * 3) / 3;
  const totalNow = Math.round(series.totalCum[mi] + (mi < N - 1 ? (series.totalCum[mi + 1] - series.totalCum[mi]) * frac : 0));
  const rowH = 34;

  return (
    <div onKeyDown={onKey} tabIndex={0} className="rounded-[2rem] outline-none focus-visible:ring-2 focus-visible:ring-cyan/40"
      role="group" aria-label="Animated replay of Japanese eCommerce store launches by region">
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
          <span className="absolute left-5 top-5 z-10 rounded-full border border-lilac/30 bg-lilac/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-lilac">Estimated regional split</span>
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" onMouseLeave={() => setHover(null)}>
            {geo.paths.map((p) => {
              const op = shade(series.cumByRegion[p.region]?.[mi] ?? 0, series.maxRegion);
              const active = hover?.region === p.region;
              return (
                <path key={p.iso2} d={p.d} fill={op > 0 ? "var(--color-cyan)" : "var(--color-cream)"}
                  fillOpacity={op > 0 ? (active ? Math.min(1, op + 0.12) : op) : 0.05}
                  stroke="var(--color-ink)" strokeOpacity={0.5} strokeWidth={active ? 1.2 : 0.5}
                  style={{ transition: "fill-opacity .6s ease" }} className="cursor-pointer"
                  onMouseMove={(e) => { const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect(); setHover({ region: p.region, x: e.clientX - r.left, y: e.clientY - r.top }); }}
                  onClick={() => router.push("/jp")}>
                  <title>{p.name} · {p.region}</title>
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

          {miniPops.filter((p) => !spot || p.domain !== spot.domain).map((p) => (
            <div key={`${p.i}-${p.domain}`} className="pointer-events-none absolute z-10 flex items-center gap-1.5 rounded-xl border border-cream/15 bg-ink-deep/85 py-1 pl-1 pr-2 shadow-lg backdrop-blur"
              style={{ left: `${Math.min(88, Math.max(12, (p.pt.x / W) * 100))}%`, top: `${(p.pt.y / H) * 100}%`, transform: "translate(-50%,-150%)", opacity: p.fresh ? 1 : 0.5, transition: "opacity .6s ease" }}>
              {/* eslint-disable-next-line @next/next/no-img-element -- external favicon service */}
              <img src={`https://www.google.com/s2/favicons?domain=${p.domain}&sz=32`} alt="" width={16} height={16} referrerPolicy="no-referrer" className="rounded" onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }} />
              <span className="max-w-[8rem] truncate text-[10px] text-cream/85">{decodeName(p.name)}</span>
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: p.g === "woo" ? "var(--color-lilac)" : "var(--color-mint)" }} />
            </div>
          ))}

          {spot && spotPt && (
            <div className="pointer-events-none absolute z-20 w-52 rounded-2xl border border-cream/20 bg-ink-deep/95 p-3 shadow-2xl backdrop-blur" style={cardPos(spotPt)}>
              <div className="mb-1.5 flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-wider text-cyan/80"><span className="h-1.5 w-1.5 rounded-full bg-cyan" /> just appeared</div>
              <div className="flex items-center gap-2">
                {/* eslint-disable-next-line @next/next/no-img-element -- external favicon service */}
                <img src={`https://www.google.com/s2/favicons?domain=${spot.domain}&sz=64`} alt="" width={22} height={22} referrerPolicy="no-referrer" className="rounded" onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }} />
                <div className="min-w-0"><div className="truncate text-sm font-semibold text-cream">{decodeName(spot.name)}</div><div className="truncate text-[11px] text-cream/45">{spot.domain}</div></div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1 text-[10px]">
                <span className="rounded-full px-2 py-0.5 font-medium" style={{ background: "color-mix(in srgb, var(--color-mint) 18%, transparent)", color: "var(--color-mint)" }}>{CMS_LABEL[spot.g]}</span>
                <span className="rounded-full bg-cream/10 px-2 py-0.5 text-cream/70">{themeOf(spot)} theme</span>
              </div>
              <div className="mt-2 space-y-1 text-[11px]">
                <div className="flex items-center justify-between"><span className="text-cream/40">Payments</span><span className="text-cream/80">{pick(JP_PAY, hash(spot.domain))}</span></div>
                <div className="flex items-center justify-between"><span className="text-cream/40">Shipping</span><span className="text-cream/80">{pick(JP_SHIP, hash(spot.domain) ^ 0x9e3779b9)}</span></div>
                <div className="flex items-center justify-between"><span className="text-cream/40">Region</span><span className="text-cream/80">{spot.r} · {REGION_JA[spot.r]}</span></div>
              </div>
            </div>
          )}

          {hover && (() => {
            const cum = series.cumByRegion[hover.region]?.[mi] ?? 0; const m = series.monthlyByRegion[hover.region]?.[mi] ?? 0;
            return (
              <div className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-xl border border-cream/20 bg-ink-deep/95 px-3 py-2 text-xs shadow-xl"
                style={{ left: `${(hover.x / W) * 100}%`, top: `calc(${(hover.y / H) * 100}% - 10px)` }} role="status">
                <div className="font-semibold text-cream">{hover.region} · {REGION_JA[hover.region]}</div>
                <div className="mt-1 text-cyan">{cum.toLocaleString()} tracked · {fmtMonth(months[mi])}</div>
                <div className="text-mint">+{m.toLocaleString()} launched · this month</div>
                <div className="mt-1 text-[10px] text-cream/40">estimated regional split</div>
              </div>
            );
          })()}
        </div>

        {/* ranked region panel */}
        <div className="rounded-[2rem] border border-cream/12 bg-cream/[0.02] p-4">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-cream/50">By region (地方)</h2>
            <span className="text-[10px] text-cream/35">{fmtMonth(months[mi])}</span>
          </div>
          <div className="relative" style={{ height: rowH * 8 }}>
            {ranked.map((r) => {
              const idx = rankIndex.get(r.region)!;
              return (
                <div key={r.region} className="absolute inset-x-0 flex items-center justify-between gap-2 rounded-lg px-2 text-sm"
                  style={{ top: idx * rowH, height: rowH - 4, transition: "top .6s cubic-bezier(.4,0,.2,1)" }}>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="w-4 shrink-0 text-right text-[11px] text-cream/30 tabular-nums">{idx + 1}</span>
                    <span className="truncate text-cream/85">{r.region}</span>
                    <span className="shrink-0 text-[11px] text-cream/35">{REGION_JA[r.region]}</span>
                  </span>
                  <span className="flex shrink-0 items-baseline gap-2 tabular-nums">
                    <span className="text-cream/70">{r.cum.toLocaleString()}</span>
                    {r.m > 0 && <span className="text-[11px] text-mint">+{r.m}</span>}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-[11px] text-cream/35"><span className="text-mint">+N</span> = stores that launched that month. Region is estimated for stores without a stated location (~{Math.round(100 - (100 * data.meta.located) / Math.max(1, data.meta.totalTracked))}% of the base) — see the note below.</p>
        </div>
      </div>

      <GrowthChart shopCum={series.shopCum} wooCum={series.wooCum} months={months}
        showShop={platform !== "woocommerce"} showWoo={platform !== "shopify"} prog={chartProg} lastRefresh={data.meta.lastRefresh} scope="Japan" scopeAdj="Japanese" />

      {/* estimation honesty note */}
      <div className="mt-4 rounded-2xl border border-lilac/20 bg-lilac/[0.04] px-5 py-3 text-[11px] leading-relaxed text-cream/45">
        <span className="font-semibold text-lilac">How the regions are estimated:</span> only about {data.meta.located.toLocaleString()} of {data.meta.totalTracked.toLocaleString()} tracked stores state a location we can pin to a region. We use that sample to estimate each region&apos;s share (Kanto/Tokyo leads, then Kansai/Osaka), then distribute the rest by those weights. Totals, launch dates and CMS are real; the region a store sits in is inferred for the unlocated majority. This becomes exact once prefecture data lands on import.
      </div>

      <OpsBox ops={data.ops ?? { scanned24h: 0, disc7d: 0, discToday: 0, recent: [] }} total={data.meta.totalTracked} playing={playing} />

      <style>{`@media (prefers-reduced-motion: reduce){svg animate{display:none}}`}</style>
    </div>
  );
}
