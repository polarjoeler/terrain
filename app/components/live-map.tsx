"use client";
/** One continuous, interactive, worldwide map. On the globe, store lights pop up sporadically across
 *  the world; it flies into the visitor's region, where real store tiles (with their CMS) spawn
 *  organically in-country; click any country to zoom in and watch its live stores appear the same way.
 *  Works for any country with sampled data — Africa, Japan, Europe, the Americas, …
 *
 *  One world Mercator throughout; zoom is a CSS transform on the map group and store tiles live inside
 *  it (counter-scaled) so everything flies together and stays aligned. Store samples + per-country
 *  totals are committed snapshots, so there is zero per-request DB work. */
import { useEffect, useMemo, useRef, useState } from "react";
import { geoMercator, geoPath } from "d3-geo";
import world from "@/lib/geo/world.json";
import { hash, mulberry32, decodeName, fmtMonth, GrowthChart } from "@/app/(app)/insights/africa/africa-replay";

type Store = { c: string; d: string; n: string; g: "shopify" | "woo" | "rest" };
type Timeline = { months: string[]; countries: Record<string, { s: number[]; w: number[]; r: number[] }>; cities: Record<string, Record<string, number[]>> };
type Feat = { iso2: string; name: string; region: string; d: string; bbox: [number, number, number, number]; cx: number; cy: number; path: Path2D | null };
type Level = "world" | "region" | "country";
const W = 960, H = 620;

const flagOf = (iso2: string) => /^[A-Za-z]{2}$/.test(iso2)
  ? String.fromCodePoint(...[...iso2.toUpperCase()].map((c) => 127397 + c.charCodeAt(0))) : "🌍";
const CMS: Record<Store["g"], { label: string; color: string }> = {
  shopify: { label: "Shopify", color: "var(--color-mint)" },
  woo: { label: "Woo", color: "var(--color-lilac)" },
  rest: { label: "CMS", color: "var(--color-orange)" },
};

// Illustrative-but-plausible payment rails per market (real providers; chosen deterministically per
// domain so a store always shows the same). Not verified per store — a catchy signal of the kind of
// tech we read, consistent with the map being the hook rather than the product.
const PAY: Record<string, string[]> = {
  ZA: ["PayFast", "Yoco", "Ozow", "Peach Payments"], KE: ["M-Pesa", "Flutterwave", "Paystack"], NG: ["Paystack", "Flutterwave", "Interswitch"],
  EG: ["Paymob", "Fawry"], GH: ["Paystack", "Hubtel"], MA: ["CMI", "Stripe"], TN: ["Konnect", "Flouci"],
  US: ["Stripe", "Shop Pay", "PayPal"], CA: ["Stripe", "Shop Pay", "PayPal"], GB: ["Stripe", "PayPal", "Klarna"],
  DE: ["Stripe", "Klarna", "PayPal"], FR: ["Stripe", "PayPal"], NL: ["Mollie", "iDEAL"], IT: ["Stripe", "PayPal"], ES: ["Stripe", "PayPal"],
  AU: ["Stripe", "Afterpay", "PayPal"], NZ: ["Stripe", "Afterpay"], IN: ["Razorpay", "Paytm", "PayU"],
  JP: ["Stripe", "PayPay", "Rakuten Pay"], BR: ["Mercado Pago", "Pix", "PagSeguro"], AE: ["Stripe", "PayTabs", "Telr"], SA: ["HyperPay", "Tap", "STC Pay"],
};
const PAY_DEF = ["Stripe", "PayPal", "Shop Pay"];
// 1–2 deterministic rails per store
const paysOf = (c: string, domain: string) => { const list = PAY[c] ?? PAY_DEF; const h = hash(domain); const a = list[h % list.length], b = list[(h >> 4) % list.length]; return a === b ? [a] : [a, b]; };

// quick-jump chips so every region is reachable in one click (then click a country inside it to drill
// in — e.g. Asia → Japan). Region ids match the `region` property baked into the world outline.
const CHIPS: { label: string; level: Level; id: string | null }[] = [
  { label: "🌍 Globe", level: "world", id: null },
  { label: "North America", level: "region", id: "North America" },
  { label: "South America", level: "region", id: "South America" },
  { label: "Europe", level: "region", id: "Europe" },
  { label: "Middle East", level: "region", id: "Middle East" },
  { label: "Africa", level: "region", id: "Africa" },
  { label: "Asia", level: "region", id: "Asia" },
  { label: "South Pacific", level: "region", id: "South Pacific" },
];

let hitCtx: CanvasRenderingContext2D | null = null;

export function LiveMap({ stores, points, tl, country = "" }: { stores: Store[]; points: { iso2: string; n: number }[]; tl: Timeline; country?: string }) {
  const reduced = useRef(false);
  const [view, setView] = useState<{ level: Level; id: string | null }>({ level: "world", id: null });

  // ---- geometry: one world Mercator; per-country path, bounds, centroid, hit-test shape ----
  const geo = useMemo(() => {
    const fc = (world as unknown as { features: { properties: { iso2?: string; name: string; region?: string }; geometry: unknown }[] }).features;
    const projection = geoMercator().fitExtent([[6, 6], [W - 6, H - 6]], world as never);
    const gp = geoPath(projection as never).digits(2);
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const feats: Feat[] = [];
    for (const f of fc) {
      const d = gp(f as never) || ""; if (!d) continue;
      const b = gp.bounds(f as never); const c = gp.centroid(f as never);
      feats.push({ iso2: f.properties.iso2 ?? "", name: f.properties.name, region: f.properties.region ?? "", d,
        bbox: [b[0][0], b[0][1], b[1][0], b[1][1]], cx: r2(c[0]), cy: r2(c[1]), path: typeof Path2D !== "undefined" ? new Path2D(d) : null });
    }
    const byIso: Record<string, Feat> = {}; for (const f of feats) if (f.iso2) byIso[f.iso2] = f;
    return { feats, byIso };
  }, []);

  const totalByIso = useMemo(() => { const m: Record<string, number> = {}; for (const p of points) m[p.iso2] = p.n; return m; }, [points]);
  const storesByCountry = useMemo(() => { const m: Record<string, Store[]> = {}; for (const s of stores) (m[s.c] ??= []).push(s); return m; }, [stores]);
  const visitorContinent = geo.byIso[country]?.region || "Africa";
  const regionOf = (iso2: string) => geo.byIso[iso2]?.region || "";
  const hasData = (iso2: string) => !!storesByCountry[iso2]?.length && !!geo.byIso[iso2];
  // the region in focus: the region we're viewing, the home of the country we drilled into, or the
  // visitor's own region on the globe. `view.id` carries the region name at region level.
  const activeContinent = view.level === "country" && view.id ? (regionOf(view.id) || visitorContinent)
    : view.level === "region" && view.id ? view.id : visitorContinent;

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

  // ---- fly target for the current view ----
  const regionSet = useMemo(() => geo.feats.filter((f) => f.region === activeContinent).map((f) => f.iso2), [geo, activeContinent]);
  const target = useMemo(() => {
    const boundsOf = (isos: string[]) => { const fs = isos.map((i) => geo.byIso[i]).filter(Boolean) as Feat[]; if (!fs.length) return { x0: 0, y0: 0, x1: W, y1: H };
      return { x0: Math.min(...fs.map((f) => f.bbox[0])), y0: Math.min(...fs.map((f) => f.bbox[1])), x1: Math.max(...fs.map((f) => f.bbox[2])), y1: Math.max(...fs.map((f) => f.bbox[3])) }; };
    if (view.level === "country" && view.id) return boundsOf([view.id]);
    if (view.level === "region") return boundsOf(regionSet);
    return { x0: 0, y0: 0, x1: W, y1: H };
  }, [view, geo, regionSet]);
  const { k, tx, ty } = useMemo(() => {
    const bw = Math.max(1, target.x1 - target.x0), bh = Math.max(1, target.y1 - target.y0), pad = 1.18;
    const kk = Math.min(18, W / (bw * pad), H / (bh * pad));
    return { k: kk, tx: W / 2 - kk * (target.x0 + target.x1) / 2, ty: H / 2 - kk * (target.y0 + target.y1) / 2 };
  }, [target]);
  const invK = 1 / k;

  // ---- auto intro: globe → the visitor's region ----
  useEffect(() => {
    reduced.current = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced.current) { setView({ level: "region", id: visitorContinent }); return; }
    const id = setTimeout(() => setView((v) => (v.level === "world" ? { level: "region", id: visitorContinent } : v)), 2900);
    return () => clearTimeout(id);
  }, [visitorContinent]);

  // ---- dynamic store spawner: tiles pop up sporadically from the current pool ----
  const [spawns, setSpawns] = useState<{ id: number; s: Store; pt: { x: number; y: number } }[]>([]);
  const poolKey = view.level + "|" + (view.id ?? visitorContinent);
  const pool = useMemo(() => {
    if (view.level === "country" && view.id) return storesByCountry[view.id] ?? [];
    if (view.level === "region") return stores.filter((s) => geo.byIso[s.c]?.region === activeContinent);
    return [];
  }, [view, stores, storesByCountry, geo, visitorContinent]);
  useEffect(() => {
    setSpawns([]);
    if (reduced.current) { // static: show a fixed sample, no motion
      setSpawns(pool.slice(0, view.level === "country" ? 12 : 10).map((s, i) => ({ id: i, s, pt: pointIn(s.c, s.d) })));
      return;
    }
    if (!pool.length) return;
    let seq = 0, t: ReturnType<typeof setTimeout>;
    const cap = view.level === "country" ? 12 : 9;
    const order = [...pool].sort(() => Math.random() - 0.5);   // shuffle so each visit differs
    // reveal ONE store at a time at a sporadic cadence — stores "being found", not a burst
    const one = () => setSpawns((prev) => { const s = order[seq % order.length]; seq++; return [...prev, { id: seq, s, pt: pointIn(s.c, s.d) }].slice(-cap); });
    const loop = () => { one(); t = setTimeout(loop, 650 + Math.random() * 700); };
    t = setTimeout(loop, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poolKey, pool]);

  // ---- dynamic globe lights: pulses pop up sporadically at real store locations worldwide ----
  const [pulses, setPulses] = useState<{ id: number; cx: number; cy: number }[]>([]);
  useEffect(() => {
    setPulses([]);
    if (reduced.current || view.level !== "world") return;
    const locs = points.map((p) => geo.byIso[p.iso2]).filter(Boolean) as Feat[]; if (!locs.length) return;
    let seq = 0, t: ReturnType<typeof setTimeout>;
    const one = () => setPulses((prev) => { const f = locs[Math.floor(Math.random() * locs.length)]; return [...prev, { id: seq++, cx: f.cx, cy: f.cy }].slice(-14); });
    const loop = () => { one(); t = setTimeout(loop, 160 + Math.random() * 320); };
    t = setTimeout(loop, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.level, points, geo]);

  // ---- timeline replay: counts tick up over time; the leaderboard + chart move in sync ----
  const Ntl = tl.months.length;
  const [t, setT] = useState(Ntl - 1);
  const [replayN, setReplayN] = useState(0);
  useEffect(() => {
    if (view.level === "world" || reduced.current) { setT(Ntl - 1); return; }
    setT(0); let raf = 0, start = 0; const dur = 6500;
    const tick = (now: number) => { if (!start) start = now; const p = Math.min(1, (now - start) / dur); setT(p * (Ntl - 1)); if (p < 1) raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poolKey, replayN, Ntl]);
  const mi = Math.max(0, Math.min(Ntl - 1, Math.floor(t)));
  const frac = Math.min(1, t - mi);

  // leaderboard entities: region → its countries; country → its top cities
  const entities = useMemo(() => {
    if (view.level === "country" && view.id) {
      const cs = tl.cities[view.id]; if (!cs) return [] as { key: string; label: string; flag: string; monthly: number[] }[];
      return Object.entries(cs).map(([name, monthly]) => ({ key: name, label: name, flag: "📍", monthly }));
    }
    const set = view.level === "region" ? new Set(regionSet) : null;
    return Object.entries(tl.countries).filter(([iso2]) => !set || set.has(iso2))
      .map(([iso2, o]) => ({ key: iso2, label: geo.byIso[iso2]?.name ?? iso2, flag: flagOf(iso2), monthly: o.s.map((v, i) => v + o.w[i] + o.r[i]) }));
  }, [view, tl, regionSet, geo]);
  const entityCum = useMemo(() => entities.map((e) => { const cum: number[] = []; let run = 0; for (let i = 0; i < e.monthly.length; i++) { run += e.monthly[i]; cum.push(run); } return { ...e, cum }; }), [entities]);

  // scoped CMS cumulative for the chart below
  const cms = useMemo(() => {
    const s = new Array(Ntl).fill(0), w = new Array(Ntl).fill(0), r = new Array(Ntl).fill(0);
    const add = (o: { s: number[]; w: number[]; r: number[] }) => { for (let i = 0; i < Ntl; i++) { s[i] += o.s[i] || 0; w[i] += o.w[i] || 0; r[i] += o.r[i] || 0; } };
    if (view.level === "country" && view.id) { if (tl.countries[view.id]) add(tl.countries[view.id]); }
    else { const set = view.level === "region" ? new Set(regionSet) : null; for (const [iso2, o] of Object.entries(tl.countries)) if (!set || set.has(iso2)) add(o); }
    const cum = (a: number[]) => { let run = 0; return a.map((v) => (run += v)); };
    return { shop: cum(s), woo: cum(w), rest: cum(r) };
  }, [view, tl, regionSet, Ntl]);

  const ranked = useMemo(() => entityCum.map((e) => {
    const cur = e.cum[mi] + (mi < Ntl - 1 ? (e.cum[mi + 1] - e.cum[mi]) * frac : 0);
    return { ...e, cur: Math.round(cur), m: e.cum[mi] - (mi > 0 ? e.cum[mi - 1] : 0) };
  }).filter((e) => e.cur > 0).sort((a, b) => b.cur - a.cur), [entityCum, mi, frac, Ntl]);
  const rankIndex = new Map(ranked.map((r, i) => [r.key, i]));
  const atT = (a: number[]) => a[mi] + (mi < Ntl - 1 ? (a[mi + 1] - a[mi]) * frac : 0);
  const scopeTotalAtT = Math.round(atT(cms.shop) + atT(cms.woo) + atT(cms.rest));
  const chartProg = Math.round(t * 3) / 3;   // quantise so the chart repaints a few times/sec, not 60fps
  const scopeName = view.level === "country" && view.id ? (geo.byIso[view.id]?.name ?? view.id) : activeContinent;

  const back = () => setView((v) => v.level === "country" ? { level: "region", id: regionOf(v.id ?? "") || visitorContinent } : { level: "world", id: null });
  // any country with sampled data is selectable from anywhere — click Japan (or anywhere) on the globe
  const clickCountry = (iso2: string) => { if (hasData(iso2)) setView({ level: "country", id: iso2 }); };

  const status = view.level === "world" ? "Scanning the globe…"
    : view.level === "country" && view.id ? `${flagOf(view.id)} ${geo.byIso[view.id]?.name ?? view.id}`
    : `Live across ${activeContinent}`;
  // ticks up as the replay plays, with the month it has reached
  const counter = view.level === "world" ? ""
    : view.level === "country" ? `${scopeTotalAtT.toLocaleString()} stores · ${fmtMonth(tl.months[mi])}`
    : `${scopeTotalAtT.toLocaleString()} stores · ${ranked.length} countries · ${fmtMonth(tl.months[mi])}`;
  const isFocus = (f: Feat) => view.level === "country" ? f.iso2 === view.id : f.region === activeContinent;
  const dimmed = (f: Feat) => view.level === "country" && f.iso2 !== view.id;

  // land is memoised so the ~175 country paths don't re-render on every spawn tick
  const land = useMemo(() => geo.feats.map((f, i) => {
    const focus = isFocus(f); const clickable = hasData(f.iso2);   // selectable at every level
    return <path key={i} d={f.d}
      fill={focus ? "var(--color-cyan)" : "var(--color-cream)"} fillOpacity={dimmed(f) ? 0.03 : focus ? 0.17 : clickable ? 0.1 : 0.05}
      stroke={focus ? "var(--color-cyan)" : "var(--color-cream)"} strokeOpacity={focus ? 0.38 : clickable ? 0.14 : 0.07} strokeWidth={0.4 * invK}
      style={{ transition: "fill-opacity .5s ease", cursor: clickable ? "pointer" : "default" }}
      onClick={() => clickCountry(f.iso2)}><title>{f.name}{clickable ? " — click to explore" : ""}</title></path>;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [geo, view, visitorContinent, invK]);

  return (
    <div>
    <div className={view.level === "world" ? "" : "grid gap-4 lg:grid-cols-[1fr_15rem]"}>
      <div className="relative overflow-hidden rounded-[2rem] border border-cream/12 bg-[radial-gradient(130%_120%_at_50%_0%,color-mix(in_srgb,var(--color-cyan)_8%,transparent),transparent_60%)]">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Interactive world map of tracked eCommerce stores">
        <g style={{ transform: `translate(${tx.toFixed(2)}px,${ty.toFixed(2)}px) scale(${k.toFixed(3)})`, transformOrigin: "0 0", transition: reduced.current ? undefined : "transform 1.8s cubic-bezier(.66,0,.2,1)" }}>
          {land}

          {/* globe: faint base pins everywhere that FLICKER, + sporadic bright sparks popping up.
              pointer-events none throughout so the decorations never swallow a country click. */}
          <g style={{ opacity: view.level === "world" ? 1 : 0, transition: "opacity .6s ease", pointerEvents: "none" }}>
            {points.map(({ iso2 }, i) => { const f = geo.byIso[iso2]; if (!f) return null;
              return <circle key={`b${i}`} cx={f.cx} cy={f.cy} r={1.5 * invK} fill="var(--color-cyan)" className="lm-twinkle"
                style={{ animationDelay: `${((i * 7) % 23) * 0.13}s`, animationDuration: `${1.3 + ((i * 5) % 7) * 0.3}s` }} />; })}
          </g>
          {view.level === "world" && pulses.map((p) => (
            <g key={`p${p.id}`} transform={`translate(${p.cx},${p.cy}) scale(${invK})`} style={{ pointerEvents: "none" }}>
              <g className="lm-spark">
                <circle r={2.5} fill="none" stroke="var(--color-mint)" strokeWidth={0.9} className="lm-ring1" />
                <circle r={2.2} fill="var(--color-mint)" />
              </g>
            </g>
          ))}

          {/* region/country: real store tiles — square cards (favicon + name + CMS + payment rails),
              popping in one at a time. pointer-events none so they don't block drilling into countries. */}
          {spawns.map((sp, i) => { const cms = CMS[sp.s.g]; const age = spawns.length - 1 - i; const pays = paysOf(sp.s.c, sp.s.d);
            return (
              <g key={`${poolKey}-${sp.id}`} transform={`translate(${sp.pt.x},${sp.pt.y}) scale(${invK})`} style={{ opacity: Math.max(0.45, 1 - age * 0.05), pointerEvents: "none" }}>
                <g className="lm-pop">
                  <circle r={4} fill="none" stroke={cms.color} strokeWidth={1} className="lm-ring1" />
                  <circle r={1.9} fill={cms.color} />
                  <foreignObject x={6} y={-54} width={180} height={60} style={{ overflow: "visible" }}>
                    <div className="w-[108px] rounded-lg border border-cream/15 bg-ink-deep/92 p-1 shadow-xl backdrop-blur">
                      <div className="flex items-center gap-1">
                        {/* eslint-disable-next-line @next/next/no-img-element -- external favicon service */}
                        <img src={`https://www.google.com/s2/favicons?domain=${sp.s.d}&sz=32`} alt="" width={12} height={12} referrerPolicy="no-referrer" className="shrink-0 rounded-sm" onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }} />
                        <span className="truncate text-[8.5px] font-semibold leading-tight text-cream/90">{decodeName(sp.s.n)}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-0.5">
                        <span className="rounded px-1 py-px text-[7.5px] font-semibold leading-none" style={{ background: `color-mix(in srgb, ${cms.color} 22%, transparent)`, color: cms.color }}>{cms.label}</span>
                        {pays.map((p) => <span key={p} className="rounded bg-cream/10 px-1 py-px text-[7.5px] leading-none text-cream/65">{p}</span>)}
                      </div>
                    </div>
                  </foreignObject>
                </g>
              </g>
            );
          })}
        </g>
      </svg>

      {/* quick-jump chips — reach any region, or Japan, in one click (not just by hunting the globe) */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-center gap-1.5 p-4">
        {CHIPS.map((c) => {
          const active = c.level === "world" ? view.level === "world"
            : c.level === "country" ? (view.level === "country" && view.id === c.id)
            : (view.level === "region" && activeContinent === c.id);
          return <button key={c.label} onClick={() => setView({ level: c.level, id: c.id })}
            className={`pointer-events-auto rounded-full border px-3 py-1 text-xs backdrop-blur transition ${active ? "border-cyan/40 bg-cyan/15 text-cream" : "border-cream/12 bg-ink-deep/40 text-cream/55 hover:text-cream"}`}>{c.label}</button>;
        })}
      </div>

      {/* overlay: caption + zoom-out */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 p-5">
        <div className="pointer-events-auto">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-mint">
            <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-mint opacity-70" /><span className="relative inline-flex h-2 w-2 rounded-full bg-mint" /></span>
            {status}
          </div>
          {counter && <div className="mt-1 font-display text-lg leading-none text-cream tabular-nums">{counter}</div>}
        </div>
        {view.level !== "world" && <button onClick={back} className="pointer-events-auto shrink-0 rounded-full border border-cream/15 bg-ink-deep/40 px-3 py-1.5 text-xs text-cream/70 backdrop-blur transition hover:text-cream">← Zoom out</button>}
      </div>
      </div>

      {/* scoped, ticking leaderboard — countries in the region, cities in a country, moving over time */}
      {view.level !== "world" && (
        <div className="rounded-[2rem] border border-cream/12 bg-cream/[0.02] p-4">
          <div className="mb-2 flex items-baseline justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-cream/50">{view.level === "country" ? "By city" : "By country"}</h3>
            <button onClick={() => setReplayN((n) => n + 1)} className="rounded-full border border-cream/15 px-2.5 py-0.5 text-[10px] text-cream/55 transition hover:text-cream">↻ Replay</button>
          </div>
          {ranked.length ? (
            <div className="relative" style={{ height: 28 * Math.min(14, ranked.length) }}>
              {ranked.map((e) => { const idx = rankIndex.get(e.key)!; const vis = idx < 14;
                return (
                  <div key={e.key} className="absolute inset-x-0 flex items-center justify-between gap-2 rounded-lg px-1.5"
                    style={{ top: idx * 28, height: 24, transition: "top .5s cubic-bezier(.4,0,.2,1), opacity .4s", opacity: vis ? 1 : 0 }}>
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="w-3.5 shrink-0 text-right text-[10px] text-cream/30 tabular-nums">{idx + 1}</span>
                      <span className="shrink-0 text-sm leading-none">{e.flag}</span>
                      <span className="truncate text-[12.5px] text-cream/85">{e.label}</span>
                    </span>
                    <span className="flex shrink-0 items-baseline gap-1.5 tabular-nums">
                      <span className="text-[12.5px] text-cream/70">{e.cur.toLocaleString()}</span>
                      {e.m > 0 && <span className="text-[10px] text-mint">+{e.m}</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : <p className="py-6 text-center text-[12px] text-cream/40">No city breakdown yet for this country.</p>}
          <p className="mt-3 text-[10px] leading-relaxed text-cream/35">Cumulative by launch date{view.level === "country" ? " · top cities" : ""}. Africa is deepest; other regions fill in as coverage widens.</p>
        </div>
      )}
    </div>

      {/* the growth chart, scoped to the current view and driven by the same replay clock */}
      {view.level !== "world" && (
        <div className="mt-4">
          <GrowthChart shopCum={cms.shop} wooCum={cms.woo} restCum={cms.rest} months={tl.months}
            showShop showWoo showRest prog={chartProg} lastRefresh={null} scope={scopeName} scopeAdj={scopeName} />
        </div>
      )}

      <style>{`
        .lm-twinkle { animation: lm-twinkle 2s ease-in-out infinite; }
        @keyframes lm-twinkle { 0%,100% { opacity: .2; } 50% { opacity: .75; } }
        .lm-pop { transform-box: fill-box; transform-origin: center; animation: lm-pop .5s cubic-bezier(.2,.9,.3,1.25) both; }
        @keyframes lm-pop { 0% { opacity: 0; transform: scale(.4); } 100% { opacity: 1; transform: scale(1); } }
        .lm-spark { transform-box: fill-box; transform-origin: center; animation: lm-spark 1.7s ease-out both; }
        @keyframes lm-spark { 0% { opacity: 0; transform: scale(.5); } 22% { opacity: 1; transform: scale(1); } 100% { opacity: 0; transform: scale(1.05); } }
        .lm-ring1 { transform-box: fill-box; transform-origin: center; animation: lm-ring1 1.4s ease-out both; }
        @keyframes lm-ring1 { 0% { transform: scale(1); opacity: .85; } 100% { transform: scale(3.4); opacity: 0; } }
        @media (prefers-reduced-motion: reduce) { .lm-twinkle,.lm-pop,.lm-spark,.lm-ring1 { animation: none; } .lm-twinkle { opacity: .5; } .lm-pop { opacity: 1; transform: none; } .lm-spark,.lm-ring1 { opacity: 0; } }
      `}</style>
    </div>
  );
}
