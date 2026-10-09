"use client";
/** The global "flight" hero — stores pop up all over the world, then the camera flies in to the
 *  visitor's region (Africa or Japan, from server-side geo detection). Pure spectacle: the catchy
 *  hook that says "we see the whole market", not the product. The real, cited, interactive replay
 *  lives in the detailed section below. World outline + store weights are committed assets, so this
 *  renders instantly with zero per-request DB work.
 *
 *  Pins are placed at the real centroids of countries where Terrain tracks stores, weighted by a
 *  committed snapshot of live counts — so even the spectacle is grounded in truth. */
import { useEffect, useMemo, useRef, useState } from "react";
import { geoNaturalEarth1, geoPath, geoCentroid } from "d3-geo";
import world from "@/lib/geo/world.json";
import africa from "@/lib/geo/africa.json";

type Feature = { properties: { iso2?: string; name: string }; geometry: unknown };
export type WorldRegion = "africa" | "japan";
const W = 960, H = 480;

function hash(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

const REGION_LABEL: Record<WorldRegion, string> = { africa: "Africa", japan: "日本" };

export function WorldHero({ region = "africa", points }: { region?: WorldRegion; points: { iso2: string; n: number }[] }) {
  const reduced = useRef(false);
  const [flown, setFlown] = useState(false);

  const geo = useMemo(() => {
    const fc = world as unknown as { features: Feature[] };
    const projection = geoNaturalEarth1().fitExtent([[10, 10], [W - 10, H - 10]], world as never);
    // digits(2) + r2 round all projection output: map trig (Math.sin/cos) differs in the last bits
    // between Node (SSR) and browser V8, which otherwise trips React's hydration check.
    const gp = geoPath(projection as never).digits(2);
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const paths = fc.features.map((f) => ({ iso2: f.properties.iso2 ?? "", d: gp(f as never) || "" }));
    const byIso: Record<string, Feature> = {};
    for (const f of fc.features) if (f.properties.iso2) byIso[f.properties.iso2] = f;

    // which countries belong to the viewer's region (for highlight + the fly-in target box)
    const africaSet = new Set((africa as unknown as { features: { properties: { iso2: string } }[] }).features.map((f) => f.properties.iso2));
    const inRegion = (iso2: string) => region === "japan" ? iso2 === "JP" : africaSet.has(iso2);
    const regionFeatures = fc.features.filter((f) => f.properties.iso2 && inRegion(f.properties.iso2));

    // fly-in transform: fit the region's projected bounds into the frame (zoom capped so pins stay sane)
    let transform = "translate(0px,0px) scale(1)";
    if (regionFeatures.length) {
      const [[x0, y0], [x1, y1]] = gp.bounds({ type: "FeatureCollection", features: regionFeatures } as never);
      const bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0), pad = 1.3;
      const k = Math.min(3.4, W / (bw * pad), H / (bh * pad));
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      transform = `translate(${(W / 2 - k * cx).toFixed(1)}px,${(H / 2 - k * cy).toFixed(1)}px) scale(${k.toFixed(3)})`;
    }

    // store pins at real country centroids, weighted by the committed snapshot (1–3 dots per country)
    const pins: { x: number; y: number; r: number; region: boolean; delay: number }[] = [];
    for (const { iso2, n } of points) {
      const f = byIso[iso2]; if (!f) continue;
      const c = projection(geoCentroid(f as never) as [number, number]); if (!c) continue;
      const reg = inRegion(iso2);
      // global countries get a single ambient dot ("stores everywhere"); the home region gets 1–3 so
      // the zoom target reads as the focus, not Germany/Australia (which lead our background imports).
      const dots = reg ? Math.min(3, 1 + Math.round(Math.sqrt(n) / 55)) : 1;
      for (let j = 0; j < dots; j++) {
        const hv = hash(iso2 + j);
        const jit = dots === 1 ? 0 : 10;
        pins.push({
          x: r2(c[0] + ((hv % 100) / 100 - 0.5) * jit),
          y: r2(c[1] + (((hv >> 7) % 100) / 100 - 0.5) * jit),
          r: reg ? 2.1 : 1.5, region: reg, delay: (hv % 2600) / 1000,
        });
      }
    }
    return { paths, transform, regionIso: new Set(regionFeatures.map((f) => f.properties.iso2)), pins };
  }, [region, points]);

  useEffect(() => {
    reduced.current = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced.current) { setFlown(true); return; }
    const id = setTimeout(() => setFlown(true), 2900);
    return () => clearTimeout(id);
  }, [region]);

  const transform = flown ? geo.transform : "translate(0px,0px) scale(1)";

  return (
    <div className="relative overflow-hidden rounded-[2rem] border border-cream/12 bg-[radial-gradient(130%_120%_at_50%_0%,color-mix(in_srgb,var(--color-cyan)_8%,transparent),transparent_60%)]">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`A world map of tracked eCommerce stores, zooming into ${REGION_LABEL[region]}`}>
        <g style={{ transform, transformOrigin: "0 0", transition: reduced.current ? undefined : "transform 1.8s cubic-bezier(.65,0,.2,1)" }}>
          {/* land */}
          {geo.paths.map((p, i) => {
            const reg = p.iso2 && geo.regionIso.has(p.iso2);
            return <path key={i} d={p.d} fill={reg ? "var(--color-cyan)" : "var(--color-cream)"}
              fillOpacity={reg ? 0.16 : 0.055} stroke={reg ? "var(--color-cyan)" : "var(--color-cream)"}
              strokeOpacity={reg ? 0.35 : 0.08} strokeWidth={0.4} />;
          })}
          {/* store pins */}
          {geo.pins.map((p, i) => (
            <g key={i} className="wh-pin" style={{ animationDelay: reduced.current ? "0s" : `${p.delay}s` }}>
              {p.region && <circle cx={p.x} cy={p.y} r={p.r} fill="none" stroke="var(--color-mint)" strokeWidth={0.5} className="wh-ring" style={{ animationDelay: `${p.delay}s` }} />}
              <circle cx={p.x} cy={p.y} r={p.r} fill={p.region ? "var(--color-mint)" : "var(--color-cyan)"} fillOpacity={p.region ? 0.95 : 0.7} />
            </g>
          ))}
        </g>
      </svg>

      {/* caption + controls, overlaid */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 p-5">
        <div className="pointer-events-auto">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-mint">
            <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-mint opacity-70" /><span className="relative inline-flex h-2 w-2 rounded-full bg-mint" /></span>
            {flown ? `Live in ${REGION_LABEL[region]}` : "Scanning the globe…"}
          </div>
          <p className="mt-1 max-w-sm text-sm text-cream/55">Stores appear where Terrain is tracking them — then we zoom into your region.</p>
        </div>
        <button onClick={() => { setFlown(false); if (!reduced.current) setTimeout(() => setFlown(true), 2900); }}
          className="pointer-events-auto shrink-0 rounded-full border border-cream/15 bg-ink-deep/40 px-3 py-1.5 text-xs text-cream/70 backdrop-blur transition hover:text-cream">↺ Replay flight</button>
      </div>

      <style>{`
        .wh-pin { opacity: 0; animation: wh-in .5s ease forwards; }
        @keyframes wh-in { from { opacity: 0; } to { opacity: 1; } }
        .wh-ring { transform-box: fill-box; transform-origin: center; animation: wh-ring 2.2s ease-out infinite; }
        @keyframes wh-ring { 0% { transform: scale(1); opacity: .8; } 70%,100% { transform: scale(4); opacity: 0; } }
        @media (prefers-reduced-motion: reduce) { .wh-pin { opacity: 1; animation: none; } .wh-ring { animation: none; opacity: 0; } }
      `}</style>
    </div>
  );
}
