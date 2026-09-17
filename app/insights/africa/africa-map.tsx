"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { geoMercator, geoPath } from "d3-geo";
import africa from "@/lib/geo/africa.json";

type Stat = { stores: number; launched30d: number };
type Feature = { properties: { iso2: string; name: string }; geometry: unknown };

// Choropleth buckets by live store count — log-ish, because ZA dwarfs everyone. Returns a
// fill-opacity on the cyan accent; no-data countries get a faint cream so the continent still reads.
function shade(stores: number | undefined): { fill: string; op: number } {
  if (!stores) return { fill: "var(--color-cream)", op: 0.06 };
  if (stores < 100) return { fill: "var(--color-cyan)", op: 0.22 };
  if (stores < 1000) return { fill: "var(--color-cyan)", op: 0.42 };
  if (stores < 5000) return { fill: "var(--color-cyan)", op: 0.66 };
  return { fill: "var(--color-cyan)", op: 0.92 };
}

export function AfricaMap({ data }: { data: Record<string, Stat> }) {
  const router = useRouter();
  const [hover, setHover] = useState<{ iso2: string; name: string; x: number; y: number } | null>(null);
  const W = 720, H = 760;

  const paths = useMemo(() => {
    const fc = africa as unknown as { features: Feature[] };
    const projection = geoMercator().fitSize([W, H], africa as never);
    const gp = geoPath(projection as never);
    return fc.features
      .map((f) => ({ iso2: f.properties.iso2, name: f.properties.name, d: gp(f as never) }))
      .filter((p): p is { iso2: string; name: string; d: string } => !!p.d);
  }, []);

  const hoveredStat = hover ? data[hover.iso2] : null;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-3xl" onMouseLeave={() => setHover(null)}>
        {paths.map((p) => {
          const st = data[p.iso2];
          const { fill, op } = shade(st?.stores);
          const active = hover?.iso2 === p.iso2;
          const clickable = !!st;
          return (
            <path
              key={p.iso2}
              d={p.d}
              fill={fill}
              fillOpacity={active ? Math.min(1, op + 0.15) : op}
              stroke="var(--color-ink)"
              strokeOpacity={0.5}
              strokeWidth={active ? 1.4 : 0.6}
              className={clickable ? "cursor-pointer" : "cursor-default"}
              onMouseMove={(e) => {
                const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                setHover({ iso2: p.iso2, name: p.name, x: e.clientX - r.left, y: e.clientY - r.top });
              }}
              onClick={() => { if (clickable) router.push(`/insights?country=${p.iso2}`); }}
            />
          );
        })}
      </svg>

      {hover && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-xl border border-cream/20 bg-ink-deep/95 px-3 py-2 text-xs shadow-xl"
          style={{ left: `${(hover.x / W) * 100}%`, top: `calc(${(hover.y / H) * 100}% - 10px)` }}
        >
          <div className="font-semibold text-cream">{hover.name}</div>
          {hoveredStat ? (
            <>
              <div className="mt-1 text-cyan">{hoveredStat.stores.toLocaleString()} stores tracked</div>
              <div className="text-mint">+{hoveredStat.launched30d.toLocaleString()} launched · last 30d</div>
              <div className="mt-1 text-[10px] text-cream/40">click to explore →</div>
            </>
          ) : (
            <div className="mt-1 text-cream/40">no coverage yet</div>
          )}
        </div>
      )}
    </div>
  );
}
