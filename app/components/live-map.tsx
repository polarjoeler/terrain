"use client";
/** One continuous, interactive map: globe → fly into the visitor's continent → live store blocks →
 *  click a country to zoom in and watch its stores appear. Not a world map and then a separate Africa
 *  map — a single zoomable surface.
 *
 *  Africa is the data-rich continent (real sampled stores placed inside each country); the globe can
 *  fly anywhere, and non-data regions show the ambient worldwide pins with a pointer to where we go
 *  deep. One world projection throughout; zoom is a CSS transform on the map group, and store cards
 *  live inside that group (counter-scaled) so everything flies together and stays aligned. */
import { useEffect, useMemo, useRef, useState } from "react";
import { geoMercator, geoPath } from "d3-geo";
import world from "@/lib/geo/world.json";
import africaGeo from "@/lib/geo/africa.json";
import { hash, mulberry32, decodeName } from "@/app/(app)/insights/africa/africa-replay";
import type { AfricaTimeline } from "@/lib/africa-timeline";

type Feat = { iso2: string; name: string; d: string; bbox: [number, number, number, number]; cx: number; cy: number; path: Path2D | null };
type Level = "world" | "region" | "country";
const W = 960, H = 620;

const flagOf = (iso2: string) => /^[A-Za-z]{2}$/.test(iso2)
  ? String.fromCodePoint(...[...iso2.toUpperCase()].map((c) => 127397 + c.charCodeAt(0))) : "🌍";

let hitCtx: CanvasRenderingContext2D | null = null;

export function LiveMap({ data, points, region = "africa" }: { data: AfricaTimeline; points: { iso2: string; n: number }[]; region?: "africa" | "japan" }) {
  const reduced = useRef(false);
  const [view, setView] = useState<{ level: Level; id: string | null }>({ level: "world", id: null });
  const [tick, setTick] = useState(0);

  // ---- geometry: one world Mercator; per-country path, bounds, centroid, hit-test shape ----
  const geo = useMemo(() => {
    const fc = (world as unknown as { features: { properties: { iso2?: string; name: string }; geometry: unknown }[] }).features;
    const projection = geoMercator().fitExtent([[6, 6], [W - 6, H - 6]], world as never);
    const gp = geoPath(projection as never).digits(2);
    const feats: Feat[] = [];
    for (const f of fc) {
      const d = gp(f as never) || ""; if (!d) continue;
      const b = gp.bounds(f as never); const c = gp.centroid(f as never);
      // round centroids: they're rendered (ambient pins) and map trig differs in the last bits across
      // V8 builds, which would trip hydration (the path `d` is already rounded via digits(2)).
      const r2 = (n: number) => Math.round(n * 100) / 100;
      feats.push({ iso2: f.properties.iso2 ?? "", name: f.properties.name, d, bbox: [b[0][0], b[0][1], b[1][0], b[1][1]], cx: r2(c[0]), cy: r2(c[1]), path: typeof Path2D !== "undefined" ? new Path2D(d) : null });
    }
    const byIso: Record<string, Feat> = {}; for (const f of feats) if (f.iso2) byIso[f.iso2] = f;
    const africaSet = new Set((africaGeo as unknown as { features: { properties: { iso2: string } }[] }).features.map((f) => f.properties.iso2));
    return { feats, byIso, africaSet };
  }, []);

  // deterministic in-country point placement (own cache; must not share AfricaReplay's projection cache)
  const ptCache = useRef(new Map<string, { x: number; y: number }>());
  const pointIn = (iso2: string, key: string) => {
    const ck = iso2 + "|" + key; const hit = ptCache.current.get(ck); if (hit) return hit;
    const f = geo.byIso[iso2]; const fb = { x: f?.cx ?? W / 2, y: f?.cy ?? H / 2 };
    if (!f || !f.path) { ptCache.current.set(ck, fb); return fb; }
    if (!hitCtx && typeof document !== "undefined") hitCtx = document.createElement("canvas").getContext("2d");
    const [x0, y0, x1, y1] = f.bbox; const rnd = mulberry32(hash(ck)); let out = fb;
    for (let i = 0; i < 40; i++) { const x = x0 + rnd() * (x1 - x0), y = y0 + rnd() * (y1 - y0); if (!hitCtx || hitCtx.isPointInPath(f.path, x, y)) { out = { x, y }; break; } }
    ptCache.current.set(ck, out); return out;
  };

  // real sampled African stores, placed inside their country
  const africaStores = useMemo(() => data.featured.filter((f) => geo.africaSet.has(f.c)).map((f) => ({ ...f, pt: pointIn(f.c, f.domain) })), [data, geo]);
  const countryTotal = (iso2: string) => { const g = data.countries[iso2]; if (!g) return 0; let s = 0; for (const k of ["shopify", "woo", "rest"] as const) for (const v of g[k]) s += v; return s; };

  // ---- fly target bounds for the current view ----
  const target = useMemo(() => {
    if (view.level === "country" && view.id && geo.byIso[view.id]) { const [x0, y0, x1, y1] = geo.byIso[view.id].bbox; return { x0, y0, x1, y1 }; }
    if (view.level === "region") {
      const set = region === "japan" ? ["JP"] : [...geo.africaSet];
      const fs = geo.feats.filter((f) => set.includes(f.iso2)); if (!fs.length) return { x0: 0, y0: 0, x1: W, y1: H };
      return { x0: Math.min(...fs.map((f) => f.bbox[0])), y0: Math.min(...fs.map((f) => f.bbox[1])), x1: Math.max(...fs.map((f) => f.bbox[2])), y1: Math.max(...fs.map((f) => f.bbox[3])) };
    }
    return { x0: 0, y0: 0, x1: W, y1: H };
  }, [view, geo, region]);

  const { k, tx, ty } = useMemo(() => {
    const bw = Math.max(1, target.x1 - target.x0), bh = Math.max(1, target.y1 - target.y0), pad = 1.18;
    const kk = Math.min(16, W / (bw * pad), H / (bh * pad));
    return { k: kk, tx: W / 2 - kk * (target.x0 + target.x1) / 2, ty: H / 2 - kk * (target.y0 + target.y1) / 2 };
  }, [target]);
  const invK = 1 / k;

  // ---- auto intro: globe → the visitor's continent; ticker drives the "stores being found" feel ----
  useEffect(() => {
    reduced.current = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced.current) { setView({ level: "region", id: null }); return; }
    const id = setTimeout(() => setView((v) => (v.level === "world" ? { level: "region", id: null } : v)), 2800);
    return () => clearTimeout(id);
  }, [region]);
  useEffect(() => { const id = setInterval(() => setTick((t) => t + 1), 1500); return () => clearInterval(id); }, []);

  const hasData = region === "africa"; // rich store-blocks + country drill live for Africa today

  // which stores to show as cards
  const shown = useMemo(() => {
    if (!hasData) return [];
    if (view.level === "country" && view.id) return africaStores.filter((f) => f.c === view.id).slice(0, 14);
    if (view.level === "region") { const n = africaStores.length; if (!n) return []; const start = (tick * 2) % n; return Array.from({ length: Math.min(10, n) }, (_, i) => africaStores[(start + i) % n]); }
    return [];
  }, [view, tick, africaStores, hasData]);

  const back = () => setView((v) => v.level === "country" ? { level: "region", id: null } : { level: "world", id: null });
  const clickCountry = (iso2: string) => { if (hasData && geo.africaSet.has(iso2) && countryTotal(iso2) > 0) setView({ level: "country", id: iso2 }); };

  const regionName = region === "japan" ? "日本" : "Africa";
  const caption = view.level === "world" ? "Scanning the globe…"
    : view.level === "country" && view.id ? `${flagOf(view.id)} ${geo.byIso[view.id]?.name ?? view.id} — ${countryTotal(view.id).toLocaleString()} stores tracked`
    : hasData ? `Live in ${regionName} — click any country to zoom in` : `Live in ${regionName}`;

  const isFocus = (iso2: string) => view.level === "country" ? iso2 === view.id : (region === "japan" ? iso2 === "JP" : geo.africaSet.has(iso2));
  const dim = (iso2: string) => view.level === "country" && iso2 !== view.id;

  return (
    <div className="relative overflow-hidden rounded-[2rem] border border-cream/12 bg-[radial-gradient(130%_120%_at_50%_0%,color-mix(in_srgb,var(--color-cyan)_8%,transparent),transparent_60%)]">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Interactive world map of tracked eCommerce stores">
        <g style={{ transform: `translate(${tx.toFixed(2)}px,${ty.toFixed(2)}px) scale(${k.toFixed(3)})`, transformOrigin: "0 0", transition: reduced.current ? undefined : "transform 1.7s cubic-bezier(.66,0,.2,1)" }}>
          {/* land */}
          {geo.feats.map((f, i) => {
            const focus = isFocus(f.iso2); const clickable = view.level !== "world" && hasData && geo.africaSet.has(f.iso2) && countryTotal(f.iso2) > 0;
            return <path key={i} d={f.d}
              fill={focus ? "var(--color-cyan)" : "var(--color-cream)"} fillOpacity={dim(f.iso2) ? 0.03 : focus ? 0.18 : 0.06}
              stroke={focus ? "var(--color-cyan)" : "var(--color-cream)"} strokeOpacity={focus ? 0.4 : 0.08} strokeWidth={0.4 * invK}
              style={{ transition: "fill-opacity .5s ease", cursor: clickable ? "pointer" : "default" }}
              onClick={() => clickCountry(f.iso2)}><title>{f.name}</title></path>;
          })}

          {/* ambient worldwide pins — only at the globe level, fading as we fly in */}
          {points.map(({ iso2 }, i) => { const f = geo.byIso[iso2]; if (!f) return null;
            return <circle key={`w${i}`} cx={f.cx} cy={f.cy} r={1.6 * invK} fill="var(--color-cyan)" fillOpacity={view.level === "world" ? 0.7 : 0}
              style={{ transition: "fill-opacity .6s ease" }} />; })}

          {/* live store blocks — real sampled stores placed in-country, counter-scaled to stay readable */}
          {shown.map((s, i) => (
            <g key={`${view.level}-${view.id}-${s.domain}`} transform={`translate(${s.pt.x},${s.pt.y}) scale(${invK})`} className="lm-store" style={{ animationDelay: reduced.current ? "0s" : `${(view.level === "country" ? i * 0.08 : 0)}s` }}>
              <circle r={5} fill="none" stroke="var(--color-mint)" strokeWidth={1} className="lm-ring" />
              <circle r={2} fill={s.g === "woo" ? "var(--color-lilac)" : "var(--color-mint)"} />
              <foreignObject x={6} y={-13} width={150} height={26}>
                <div className="flex items-center gap-1 rounded-lg border border-cream/15 bg-ink-deep/85 py-0.5 pl-0.5 pr-1.5 shadow-md backdrop-blur" style={{ width: "fit-content" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- external favicon service */}
                  <img src={`https://www.google.com/s2/favicons?domain=${s.domain}&sz=32`} alt="" width={12} height={12} referrerPolicy="no-referrer" className="rounded-sm" onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }} />
                  <span className="max-w-[6.5rem] truncate text-[9px] leading-none text-cream/85">{decodeName(s.name)}</span>
                </div>
              </foreignObject>
            </g>
          ))}
        </g>
      </svg>

      {/* overlay: caption + controls */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 p-5">
        <div className="pointer-events-auto">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-mint">
            <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-mint opacity-70" /><span className="relative inline-flex h-2 w-2 rounded-full bg-mint" /></span>
            {caption}
          </div>
          {!hasData && view.level !== "world" && <p className="mt-1 max-w-sm text-sm text-cream/55">Deep, store-level coverage is live in Africa &amp; Japan — <a href="/japan" className="text-cyan hover:brightness-110">explore →</a></p>}
        </div>
        <div className="pointer-events-auto flex items-center gap-2">
          {view.level !== "world" && <button onClick={back} className="rounded-full border border-cream/15 bg-ink-deep/40 px-3 py-1.5 text-xs text-cream/70 backdrop-blur transition hover:text-cream">← Zoom out</button>}
          {view.level === "world" && <button onClick={() => setView({ level: "region", id: null })} className="rounded-full border border-cream/15 bg-ink-deep/40 px-3 py-1.5 text-xs text-cream/70 backdrop-blur transition hover:text-cream">Skip to {regionName} →</button>}
        </div>
      </div>

      <style>{`
        .lm-store { opacity: 0; animation: lm-in .5s ease forwards; }
        @keyframes lm-in { to { opacity: 1; } }
        .lm-ring { transform-box: fill-box; transform-origin: center; animation: lm-ring 2.2s ease-out infinite; }
        @keyframes lm-ring { 0% { transform: scale(1); opacity: .8; } 70%,100% { transform: scale(3.5); opacity: 0; } }
        @media (prefers-reduced-motion: reduce) { .lm-store { opacity: 1; animation: none; } .lm-ring { animation: none; opacity: 0; } }
      `}</style>
    </div>
  );
}
