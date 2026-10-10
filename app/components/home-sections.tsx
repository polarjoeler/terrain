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

/** The umbrella intro — "What Terrain does" — framing everything below it: the lead dashboard and
 *  integrations, the role-based digest, and the market signals we read. */
export function WhatWeDo() {
  return (
    <section id="what" className="px-4 pt-20 pb-4">
      <div className="mx-auto max-w-6xl">
        <span className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan">What Terrain does</span>
        <h2 className="mt-3 max-w-3xl font-display text-4xl tracking-tight md:text-5xl">One market — turned into leads, intelligence and a weekly digest.</h2>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-cream/60">
          We read every store on the continent — the platform it&apos;s built on, the payments and tech it runs, the group it belongs to, the clones chasing it, and every migration — then hand it to you three ways: a live <span className="text-cream/80">lead dashboard</span> you can push into Sheets, your CRM, Slack or WhatsApp; the <span className="text-cream/80">market intelligence</span> behind it; and a <span className="text-cream/80">weekly digest</span> tuned to your role.
        </p>
      </div>
    </section>
  );
}

/** The capability rhythm: alternating text / visual bands, same shape each time. */
export function Capabilities() {
  return (
    <section id="capabilities" className="px-4 pb-20 pt-8">
      <div className="mx-auto max-w-6xl">
        <span className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan">Every signal we read</span>
        <h2 className="mt-3 max-w-2xl font-display text-4xl tracking-tight md:text-5xl">The whole market, read four ways.</h2>
        <p className="mt-3 max-w-xl text-cream/55">Under every lead sits the full picture — what a store is built with, who it pays, the group it belongs to, and the clones chasing it.</p>

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
  { name: "Squarespace", file: "squarespace.svg" },
  { name: "BigCommerce", file: "bigcommerce.svg" },
  { name: "Webflow", file: "webflow.svg" },
  { name: "PrestaShop", file: "prestashop.svg" },
  { name: "Shopware", file: "shopware.svg" },
  { name: "VTEX", file: "vtex.svg" },
  { name: "Big Cartel", file: "bigcartel.svg" },
  { name: "Adobe Commerce" },
  { name: "Ecwid" },
];

// One platform mark: just the brand glyph, masked to the current text colour so it stays monochrome
// and brightens on hover. The name lives in the title/aria-label (tooltip + a11y), not on screen.
function PlatformMark({ name, file }: { name: string; file: string }) {
  return (
    <span role="img" aria-label={name} title={name} className="h-8 w-8 shrink-0 bg-cream/45 transition hover:bg-cream/90" style={{
      WebkitMaskImage: `url(/logos/${file})`, maskImage: `url(/logos/${file})`,
      WebkitMaskRepeat: "no-repeat", maskRepeat: "no-repeat",
      WebkitMaskPosition: "center", maskPosition: "center",
      WebkitMaskSize: "contain", maskSize: "contain",
    }} />
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
        {/* logos only — platforms without official artwork (Adobe Commerce, Ecwid) stay hidden until
            their mark lands in /public/logos, at which point they appear automatically */}
        <div className="mt-9 flex flex-wrap items-center justify-center gap-x-10 gap-y-6">
          {PLATFORMS.filter((p) => p.file).map((p) => <PlatformMark key={p.name} name={p.name} file={p.file!} />)}
        </div>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- platform preview + integrations */

const flag = (iso2: string) => /^[A-Za-z]{2}$/.test(iso2) ? String.fromCodePoint(...[...iso2.toUpperCase()].map((c) => 127397 + c.charCodeAt(0))) : "🌍";

// A masked monochrome logo at an arbitrary path (brand marks live under /public/logos).
function Mark({ src, name, size = "h-6 w-6", tint = "bg-cream/70" }: { src: string; name: string; size?: string; tint?: string }) {
  return <span role="img" aria-label={name} title={name} className={`${size} shrink-0 ${tint}`} style={{
    WebkitMaskImage: `url(${src})`, maskImage: `url(${src})`, WebkitMaskRepeat: "no-repeat", maskRepeat: "no-repeat",
    WebkitMaskPosition: "center", maskPosition: "center", WebkitMaskSize: "contain", maskSize: "contain",
  }} />;
}

const TAG: Record<string, string> = { New: "text-mint", Plus: "text-cyan", Migrated: "text-orange" };
// Illustrative preview rows (a product mockup — not claims about specific stores; deliberately NO
// revenue figures). CMS/market/status are the kinds of columns the real dashboard shows.
const MOCK_LEADS = [
  { name: "Kefi Collection", c: "ZA", cms: "Shopify", tag: "New" },
  { name: "Lagos Linen Co.", c: "NG", cms: "WooCommerce", tag: "New" },
  { name: "Nairobi Naturals", c: "KE", cms: "Shopify", tag: "Plus" },
  { name: "Accra Active", c: "GH", cms: "WooCommerce", tag: "Migrated" },
  { name: "Cape Ceramics", c: "ZA", cms: "Shopify", tag: "New" },
];
const MOCK_STATS = [
  { label: "New this week", value: "1,284", delta: "▲ +112" },
  { label: "Shopify Plus", value: "37", delta: "▲ +4" },
  { label: "Migrations", value: "58", delta: "▲ +9" },
  { label: "Churned", value: "41", delta: "▼ −6" },
];

// A static mockup of the in-app Overview + lead dashboard.
function DashboardMock() {
  return (
    <div className="overflow-hidden rounded-2xl border border-cream/12 bg-ink-deep/70 shadow-2xl">
      <div className="flex items-center gap-2 border-b border-cream/10 px-4 py-2.5">
        <span className="flex gap-1.5"><i className="h-2 w-2 rounded-full bg-cream/20" /><i className="h-2 w-2 rounded-full bg-cream/20" /><i className="h-2 w-2 rounded-full bg-cream/20" /></span>
        <span className="ml-2 font-mono text-[11px] text-cream/40">terrain · Overview</span>
        <span className="ml-auto rounded-full bg-cream/10 px-2 py-0.5 text-[10px] text-cream/50">ZA · KE · NG</span>
      </div>
      <div className="p-4">
        <div className="grid grid-cols-4 gap-2">
          {MOCK_STATS.map((s) => (
            <div key={s.label} className="rounded-xl border border-cream/10 bg-cream/[0.03] p-2.5">
              <div className="truncate text-[9px] uppercase tracking-wide text-cream/40">{s.label}</div>
              <div className="mt-1 font-display text-lg leading-none text-cream tabular-nums">{s.value}</div>
              <div className="mt-1 font-mono text-[9px] text-mint">{s.delta}</div>
            </div>
          ))}
        </div>
        <div className="mt-3 overflow-hidden rounded-xl border border-cream/10">
          <div className="flex items-center justify-between border-b border-cream/10 bg-cream/[0.02] px-3 py-1.5 text-[9px] font-semibold uppercase tracking-wide text-cream/35">
            <span>Latest leads</span><span>Push to →</span>
          </div>
          {MOCK_LEADS.map((l) => (
            <div key={l.name} className="flex items-center gap-2 border-b border-cream/[0.06] px-3 py-2 last:border-0">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-cream/10 text-[10px] font-semibold text-cream/60">{l.name[0]}</span>
              <span className="truncate text-[11px] text-cream/85">{l.name}</span>
              <span className="shrink-0 text-[10px] text-cream/40">{flag(l.c)}</span>
              <span className="shrink-0 rounded-full bg-cream/[0.08] px-1.5 py-0.5 text-[9px] text-cream/55">{l.cms}</span>
              <span className={`shrink-0 text-[9px] font-semibold ${TAG[l.tag]}`}>{l.tag}</span>
              <span className="ml-auto flex shrink-0 items-center gap-1 opacity-60">
                <Mark src="/logos/integrations/googlesheets.svg" name="Export to Google Sheets" size="h-3.5 w-3.5" tint="bg-cream/50" />
                <Mark src="/logos/integrations/slack.svg" name="Send to Slack" size="h-3.5 w-3.5" tint="bg-cream/50" />
                <Mark src="/logos/integrations/whatsapp.svg" name="Send to WhatsApp" size="h-3.5 w-3.5" tint="bg-cream/50" />
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const DESTINATIONS = [
  { file: "googlesheets.svg", name: "Google Sheets", line: "Export a live, filtered sheet in a click." },
  { file: "slack.svg", name: "Slack", line: "New-store and switch alerts in your channel." },
  { file: "whatsapp.svg", name: "WhatsApp", line: "Hot leads straight to your phone." },
];
const CRMS = [{ file: "hubspot.svg", name: "HubSpot" }, { file: "salesforce.svg", name: "Salesforce" }, { file: "zoho.svg", name: "Zoho" }];

/** Preview of the product + the integrations that get leads into the user's workflow. */
export function PlatformPreview() {
  return (
    <section id="platform" className="px-4 py-20">
      <div className="mx-auto max-w-6xl">
        <span className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan">The platform</span>
        <h2 className="mt-3 max-w-2xl font-display text-4xl tracking-tight md:text-5xl">From the map to your pipeline.</h2>
        <p className="mt-3 max-w-xl text-cream/55">Explore the market in your Overview, filter the lead dashboard to exactly the stores you want — by market, platform, payment tech or launch date — then push them into the tools your team already runs.</p>

        <div className="mt-12 grid items-center gap-10 md:grid-cols-[1.35fr_1fr]">
          <DashboardMock />
          <div>
            <h3 className="font-display text-2xl tracking-tight text-cream">Pull leads into your stack.</h3>
            <p className="mt-2 text-sm text-cream/55">One click from a filtered list to where you actually work.</p>
            <div className="mt-6 space-y-4">
              {DESTINATIONS.map((d) => (
                <div key={d.name} className="flex items-center gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cream/12 bg-cream/[0.03]"><Mark src={`/logos/integrations/${d.file}`} name={d.name} size="h-5 w-5" tint="bg-cream/80" /></span>
                  <div><div className="text-sm font-semibold text-cream">{d.name}</div><div className="text-[12.5px] text-cream/55">{d.line}</div></div>
                </div>
              ))}
            </div>
            <div className="mt-6 border-t border-cream/10 pt-5">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cream/40">…and sync to your CRM</div>
              <div className="mt-3 flex items-center gap-5">
                {CRMS.map((c) => <Mark key={c.name} src={`/logos/integrations/${c.file}`} name={c.name} size="h-6 w-6" tint="bg-cream/55" />)}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- the digest, by role */

const ROLES: { icon: string; role: string; lines: string[] }[] = [
  { icon: "💳", role: "Payment providers", lines: ["118 live stores on no gateway in Kenya", "2 competitors' merchants churned", "Flutterwave added 14 stores this week"] },
  { icon: "🏢", role: "Agencies", lines: ["9 new stores in your niche", "5 prospects migrated off Wix", "3 stores overdue a redesign"] },
  { icon: "📈", role: "Investors & analysts", lines: ["Shopify share +1.2pts in Nigeria", "Beauty is the fastest-growing category", "Migration flows into Shopify Plus"] },
  { icon: "🧩", role: "App & tech vendors", lines: ["22 stores just added a subscriptions app", "Your integration vs the field", "Stores missing your category"] },
];

/** The weekly digest — the paid payoff, tailored per role on a team. */
export function DigestByRole() {
  return (
    <section id="digest" className="px-4 py-16 pb-20">
      <div className="mx-auto max-w-6xl">
        <span className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan">The weekly digest</span>
        <h2 className="mt-3 max-w-2xl font-display text-4xl tracking-tight md:text-5xl">Monday morning, tuned to each role.</h2>
        <p className="mt-3 max-w-xl text-cream/55">Not one more dashboard to check — the handful of moves that matter, in your inbox. Everyone on the team gets a digest built for what they actually do.</p>

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {ROLES.map((r) => (
            <div key={r.role} className="flex flex-col rounded-2xl border border-cream/12 bg-cream/[0.02] p-5">
              <span className="text-xl">{r.icon}</span>
              <div className="mt-2 font-display text-lg text-cream">{r.role}</div>
              <ul className="mt-3 space-y-2">
                {r.lines.map((l) => (
                  <li key={l} className="flex gap-2 text-[12.5px] leading-snug text-cream/60"><span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-mint" />{l}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="mt-6 text-[12px] text-cream/35">Illustrative — your digest is built from your market, your competitors and your filters.</p>
      </div>
    </section>
  );
}
