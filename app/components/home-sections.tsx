/** Homepage capability bands — the product story, told as a calm repeating rhythm: one capability
 *  per band, each with a single purpose-built visual and one sentence. Server-rendered (static SVG +
 *  CSS keyframes, reduced-motion-guarded) so nothing ships to the client. The map hero sells the
 *  excitement; THIS sells what Terrain actually does. Visuals are original, abstract data-art — no
 *  third-party logo artwork. */
import type { ReactNode } from "react";

/* ----------------------------------------------------------------- capability visuals (SVG) */

// Migrations — stores leaving older platforms and landing on the leaders. Left stack flows along
// arcs to the right node; the moving dash says "in motion".
function MigrationViz() {
  const from = [
    { y: 46, label: "Magento", c: "var(--color-orange)" },
    { y: 110, label: "Wix", c: "var(--color-lilac)" },
    { y: 174, label: "WooCommerce", c: "var(--color-lilac)" },
  ];
  return (
    <svg viewBox="0 0 340 220" className="h-auto w-full" role="img" aria-label="Stores migrating from older platforms onto the market leaders">
      {from.map((f, i) => (
        <path key={i} d={`M96 ${f.y} C 180 ${f.y}, 190 110, 250 110`} fill="none" stroke={f.c} strokeOpacity={0.5} strokeWidth={2}
          strokeDasharray="4 6" className="hs-flow" style={{ animationDelay: `${i * 0.5}s` }} />
      ))}
      {from.map((f, i) => (
        <g key={`n${i}`}>
          <circle cx={78} cy={f.y} r={13} fill="color-mix(in srgb, var(--color-cream) 7%, transparent)" stroke={f.c} strokeOpacity={0.6} />
          <text x={60} y={f.y + 28} textAnchor="middle" className="fill-cream" fillOpacity={0.5} style={{ fontSize: 11 }}>{f.label}</text>
        </g>
      ))}
      <circle cx={262} cy={110} r={22} fill="color-mix(in srgb, var(--color-mint) 16%, transparent)" stroke="var(--color-mint)" strokeOpacity={0.8} strokeWidth={1.5} />
      <text x={262} y={114} textAnchor="middle" className="fill-cream" style={{ fontSize: 12, fontWeight: 600 }}>Shopify</text>
      <text x={262} y={168} textAnchor="middle" className="fill-mint" style={{ fontSize: 13, fontWeight: 700 }}>+ net gain</text>
    </svg>
  );
}

// Store groups — one brand, many storefronts. A hub with spokes to satellite stores; we stitch the
// portfolio back together even when each runs on its own domain.
function GroupsViz() {
  const sats = [
    [262, 40], [300, 96], [286, 160], [220, 188], [150, 180], [96, 150], [78, 92], [120, 44],
  ];
  const cx = 186, cy = 110;
  return (
    <svg viewBox="0 0 340 220" className="h-auto w-full" role="img" aria-label="One brand running many storefronts, linked into a single group">
      {sats.map(([x, y], i) => (
        <line key={`l${i}`} x1={cx} y1={cy} x2={x} y2={y} stroke="var(--color-cyan)" strokeOpacity={0.28} strokeWidth={1.2} />
      ))}
      {sats.map(([x, y], i) => (
        <circle key={`s${i}`} cx={x} cy={y} r={8} fill="color-mix(in srgb, var(--color-cyan) 14%, transparent)" stroke="var(--color-cyan)" strokeOpacity={0.55}
          className="hs-pulse" style={{ animationDelay: `${i * 0.35}s` }} />
      ))}
      <circle cx={cx} cy={cy} r={26} fill="color-mix(in srgb, var(--color-cyan) 22%, transparent)" stroke="var(--color-cyan)" strokeWidth={1.5} />
      <text x={cx} y={cy - 2} textAnchor="middle" className="fill-cream" style={{ fontSize: 12, fontWeight: 700 }}>1 brand</text>
      <text x={cx} y={cy + 13} textAnchor="middle" className="fill-cream" fillOpacity={0.6} style={{ fontSize: 10 }}>8 stores</text>
    </svg>
  );
}

// Clones & fraud — a catalogue fingerprint sweeps a grid of storefronts and flags the copies. Two
// tiles light up as matches, linked back to the original.
function FraudViz() {
  const cells: [number, number][] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) cells.push([40 + c * 68, 40 + r * 58]);
  const flagged = new Set([5, 10]);
  const origin = cells[0];
  return (
    <svg viewBox="0 0 340 220" className="h-auto w-full" role="img" aria-label="A catalogue fingerprint detecting stores copying a brand">
      {cells.map(([x, y], i) => {
        const bad = flagged.has(i);
        return (
          <g key={i}>
            <rect x={x} y={y} width={46} height={40} rx={6}
              fill={bad ? "color-mix(in srgb, var(--color-orange) 16%, transparent)" : "color-mix(in srgb, var(--color-cream) 5%, transparent)"}
              stroke={bad ? "var(--color-orange)" : "var(--color-cream)"} strokeOpacity={bad ? 0.85 : 0.12} strokeWidth={bad ? 1.4 : 1}
              className={bad ? "hs-flag" : undefined} />
            {i === 0 && <rect x={x} y={y} width={46} height={40} rx={6} fill="none" stroke="var(--color-mint)" strokeWidth={1.4} />}
            {bad && <text x={x + 23} y={y + 25} textAnchor="middle" className="fill-orange" style={{ fontSize: 13, fontWeight: 700 }}>!</text>}
          </g>
        );
      })}
      {[...flagged].map((i) => (
        <line key={`ln${i}`} x1={origin[0] + 23} y1={origin[1] + 20} x2={cells[i][0] + 23} y2={cells[i][1] + 20}
          stroke="var(--color-orange)" strokeOpacity={0.45} strokeWidth={1.2} strokeDasharray="3 4" />
      ))}
      <text x={origin[0] + 23} y={origin[1] - 8} textAnchor="middle" className="fill-mint" style={{ fontSize: 10, fontWeight: 600 }}>original</text>
      <text x={300} y={206} textAnchor="end" className="fill-orange" style={{ fontSize: 12, fontWeight: 700 }}>2 clones · 98% match</text>
    </svg>
  );
}

// Tech & payments — the rails stores actually run, ranked by adoption. A simple share chart; the
// bars are the choices merchants make at checkout.
function RailsViz() {
  const rails = [
    { label: "Paystack", v: 0.9, c: "var(--color-mint)" },
    { label: "Flutterwave", v: 0.72, c: "var(--color-cyan)" },
    { label: "PayFast", v: 0.58, c: "var(--color-lilac)" },
    { label: "Yoco", v: 0.4, c: "var(--color-mint)" },
    { label: "M-Pesa", v: 0.3, c: "var(--color-cyan)" },
  ];
  const x0 = 96, w = 210, h = 22, gap = 14;
  return (
    <svg viewBox="0 0 340 220" className="h-auto w-full" role="img" aria-label="Payment rails ranked by how many stores use them">
      {rails.map((r, i) => {
        const y = 18 + i * (h + gap);
        return (
          <g key={i}>
            <text x={x0 - 10} y={y + 15} textAnchor="end" className="fill-cream" fillOpacity={0.6} style={{ fontSize: 11 }}>{r.label}</text>
            <rect x={x0} y={y} width={w} height={h} rx={5} fill="color-mix(in srgb, var(--color-cream) 5%, transparent)" />
            <rect x={x0} y={y} width={w * r.v} height={h} rx={5} fill={r.c} fillOpacity={0.55} className="hs-grow" style={{ animationDelay: `${i * 0.12}s` }} />
          </g>
        );
      })}
    </svg>
  );
}

/* ----------------------------------------------------------------- band layout */

type Band = { tag: string; title: string; body: string; viz: ReactNode };
const BANDS: Band[] = [
  { tag: "Switchboard · migrations", title: "Watch the market switch rails.", viz: <MigrationViz />,
    body: "Stores don't stay still. We track every move off an old platform or provider and onto a new one — who's switching, where, and to whom — so you see share change before it shows up anywhere else." },
  { tag: "Groups & portfolios", title: "One brand, many storefronts — stitched together.", viz: <GroupsViz />,
    body: "The biggest operators run dozens of stores across their own domains. We link them back into a single group, so a portfolio reads as one player instead of scattered noise." },
  { tag: "Radar · clones & fraud", title: "Find the stores copying you.", viz: <FraudViz />,
    body: "Radar fingerprints a catalogue — images, SKUs, prices — and sweeps the market for storefronts copying it, then keeps watching for new ones. Brand abuse, caught early." },
  { tag: "Tech & payments", title: "See the stack every store runs.", viz: <RailsViz />,
    body: "Platform, theme, apps, shipping — and the payment rails merchants actually choose at checkout, ranked by adoption and tracked as they rise and fall across each market." },
];

/** The capability rhythm: alternating text / visual bands, same shape each time. */
export function Capabilities() {
  return (
    <section id="capabilities" className="px-4 py-20">
      <div className="mx-auto max-w-6xl">
        <span className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan">What Terrain does</span>
        <h2 className="mt-3 max-w-2xl font-display text-4xl tracking-tight md:text-5xl">The whole market, read four ways.</h2>
        <p className="mt-3 max-w-xl text-cream/55">Every store, what it&apos;s built with, who it pays, and how it moves — turned into intelligence you can act on.</p>

        <div className="mt-14 flex flex-col gap-16 md:gap-24">
          {BANDS.map((b, i) => (
            <div key={b.tag} className="grid items-center gap-8 md:grid-cols-2 md:gap-14">
              <div className={i % 2 === 1 ? "md:order-2" : ""}>
                <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cream/40">{b.tag}</span>
                <h3 className="mt-3 font-display text-3xl tracking-tight text-cream md:text-4xl">{b.title}</h3>
                <p className="mt-4 max-w-md leading-relaxed text-cream/60">{b.body}</p>
                <a href="#join" className="mt-5 inline-block text-sm text-cyan transition hover:brightness-110">Get early access →</a>
              </div>
              <div className={`rounded-[2rem] border border-cream/12 bg-cream/[0.02] p-6 ${i % 2 === 1 ? "md:order-1" : ""}`}>
                {b.viz}
              </div>
            </div>
          ))}
        </div>
      </div>

      <style>{`
        .hs-flow { animation: hs-dash 1.6s linear infinite; }
        @keyframes hs-dash { to { stroke-dashoffset: -20; } }
        .hs-pulse { transform-box: fill-box; transform-origin: center; animation: hs-pulse 2.4s ease-in-out infinite; }
        @keyframes hs-pulse { 0%,100% { opacity: .55; } 50% { opacity: 1; } }
        .hs-flag { animation: hs-flag 2s ease-in-out infinite; }
        @keyframes hs-flag { 0%,100% { opacity: .6; } 50% { opacity: 1; } }
        .hs-grow { transform-box: fill-box; transform-origin: left center; animation: hs-grow .9s cubic-bezier(.2,.8,.2,1) both; }
        @keyframes hs-grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
        @media (prefers-reduced-motion: reduce) { .hs-flow, .hs-pulse, .hs-flag, .hs-grow { animation: none; } }
      `}</style>
    </section>
  );
}

// Platforms Terrain reads the stack across. `file` points at an official brand mark in /public/logos
// (rendered monochrome via CSS mask so it recolors to the theme); platforms without a committed file
// fall back to a styled wordmark. Drop an official SVG in and add its filename here to light it up.
const PLATFORMS: { name: string; file?: string }[] = [
  { name: "Shopify", file: "shopify.svg" },
  { name: "WooCommerce", file: "woocommerce.svg" },
  { name: "Wix", file: "wix.svg" },
  { name: "Adobe Commerce" },
  { name: "Squarespace", file: "squarespace.svg" },
  { name: "BigCommerce", file: "bigcommerce.svg" },
  { name: "PrestaShop", file: "prestashop.svg" },
  { name: "Ecwid" },
];

// One platform mark: the brand glyph (masked to the current text colour) + name, or a wordmark when
// we don't yet have the official artwork. Hovering lifts glyph and name together via currentColor.
function PlatformMark({ name, file }: { name: string; file?: string }) {
  if (!file) return <span className="font-display text-base font-semibold text-cream/45 transition hover:text-cream/80">{name}</span>;
  return (
    <span className="flex items-center gap-2 text-cream/45 transition hover:text-cream/90">
      <span aria-hidden className="h-5 w-5 shrink-0 bg-current" style={{
        WebkitMaskImage: `url(/logos/${file})`, maskImage: `url(/logos/${file})`,
        WebkitMaskRepeat: "no-repeat", maskRepeat: "no-repeat",
        WebkitMaskPosition: "center", maskPosition: "center",
        WebkitMaskSize: "contain", maskSize: "contain",
      }} />
      <span className="font-display text-base font-semibold">{name}</span>
    </span>
  );
}

/** The CMS-tracking credibility band — the "what we read" mention, with official platform marks. */
export function TechStrip() {
  return (
    <section className="border-y border-cream/10 bg-cream/[0.015] px-6 py-14">
      <div className="mx-auto max-w-5xl text-center">
        <span className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan">The technology behind every store</span>
        <h2 className="mx-auto mt-3 max-w-2xl font-display text-2xl tracking-tight text-cream md:text-3xl">
          We read the stack across every leading eCommerce platform.
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-sm text-cream/50">
          Whatever a store is built on, Terrain detects it — and the themes, apps, payment and shipping tech layered on top.
        </p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-x-9 gap-y-5">
          {PLATFORMS.map((p) => <PlatformMark key={p.name} {...p} />)}
        </div>
      </div>
    </section>
  );
}
