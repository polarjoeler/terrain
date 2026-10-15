"use client";

import { createContext, useContext, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { classify, PAY_TYPES, type PayType } from "@/lib/payments-taxonomy";
import type { ProviderMomentum, PaymentShift } from "@/lib/provider-insights";
import { marketLabel, marketAdjective, groupByRegion } from "@/lib/markets";
import { tagLabel } from "@/lib/tag-defs";
import type { InsightsData, InsightItem, PlatformSel, DistroKey } from "@/lib/insights";

// CMS decoration for the picker + chart titles. Kept client-side (a copy of PLATFORM_META in
// lib/insights) so this "use client" file doesn't pull the server-only insights module into the
// bundle. The picker itself is data-driven — this only labels/colours the slugs that appear.
const PLATFORM_META: Record<string, { label: string; dot: string }> = {
  all: { label: "All", dot: "#8fb0c4" },
  shopify: { label: "Shopify", dot: "#95BF47" },
  woocommerce: { label: "WooCommerce", dot: "#96588a" },
  magento: { label: "Magento", dot: "#f26322" },
  wix: { label: "Wix", dot: "#faad4d" },
  base: { label: "BASE", dot: "#1e88e5" },
  squarespace: { label: "Squarespace", dot: "#111111" },
  cafe24: { label: "Cafe24", dot: "#3fb1ce" },
  "ec-cube": { label: "EC-CUBE", dot: "#e94709" },
  colorme: { label: "カラーミー", dot: "#f06d6d" },
  makeshop: { label: "MakeShop", dot: "#e2211c" },
  "salesforce commerce cloud": { label: "Salesforce", dot: "#00a1e0" },
  bigcommerce: { label: "BigCommerce", dot: "#121118" },
  prestashop: { label: "PrestaShop", dot: "#df0067" },
  webflow: { label: "Webflow", dot: "#146ef5" },
  shopstar: { label: "ShopStar", dot: "#ff6f61" },
  vtex: { label: "VTEX", dot: "#f71963" },
};
const platformLabel = (p: string): string =>
  PLATFORM_META[p]?.label ?? (p ? p.charAt(0).toUpperCase() + p.slice(1) : "All");
const platformDot = (p: string): string => PLATFORM_META[p]?.dot ?? "#8fb0c4";
import { GrowthChart } from "@/app/components/growth-chart";
import { PlatformGrowthChart } from "@/app/components/platform-growth-chart";
import { InsightsNav } from "./insights-nav";

/** Donut of the platform mix — hover a slice (or legend) for that CMS's store count + share; the
 *  centre reflects the hovered slice, and clicking scopes the whole report to it. */
function PlatformDonut({ slices, totalLive, onPick }: {
  slices: { key: string; label: string; live: number; color: string; pickable: boolean }[];
  totalLive: number;
  onPick: (key: string) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const R = 72, r = 46, c = 82;
  const pt = (ang: number, rad: number): [number, number] =>
    [c + rad * Math.cos(ang * 2 * Math.PI - Math.PI / 2), c + rad * Math.sin(ang * 2 * Math.PI - Math.PI / 2)];
  let acc = 0;
  const arcs = slices.map((s) => { const start = acc; acc += s.live / (totalLive || 1); return { ...s, start, end: acc }; });
  const path = (start: number, end: number) => {
    const [x0o, y0o] = pt(start, R), [x1o, y1o] = pt(end, R), [x1i, y1i] = pt(end, r), [x0i, y0i] = pt(start, r);
    const large = end - start > 0.5 ? 1 : 0;
    return `M${x0o.toFixed(1)},${y0o.toFixed(1)} A${R},${R} 0 ${large} 1 ${x1o.toFixed(1)},${y1o.toFixed(1)} L${x1i.toFixed(1)},${y1i.toFixed(1)} A${r},${r} 0 ${large} 0 ${x0i.toFixed(1)},${y0i.toFixed(1)} Z`;
  };
  const pct = (live: number) => (totalLive ? Math.round((live / totalLive) * 100) : 0);
  const h = hover != null ? arcs[hover] : null;
  return (
    <div className="flex flex-wrap items-center gap-5">
      <svg viewBox="0 0 164 164" className="h-40 w-40 shrink-0" onMouseLeave={() => setHover(null)}>
        {arcs.map((a, i) => (
          <path key={a.key} d={path(a.start, a.end)} fill={a.color}
            opacity={hover == null || hover === i ? 1 : 0.3}
            className={`transition-opacity ${a.pickable ? "cursor-pointer" : ""}`}
            onMouseEnter={() => setHover(i)} onClick={() => a.pickable && onPick(a.key)} />
        ))}
        <text x={c} y={c - 3} textAnchor="middle" className="fill-cream font-display" fontSize="22">{(h ? h.live : totalLive).toLocaleString()}</text>
        <text x={c} y={c + 14} textAnchor="middle" className="fill-cream/55" fontSize="9">{h ? `${h.label} · ${pct(h.live)}%` : "live stores"}</text>
      </svg>
      <div className="flex flex-wrap content-center gap-x-4 gap-y-1.5">
        {arcs.map((a, i) => (
          <button key={a.key} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onClick={() => a.pickable && onPick(a.key)}
            title={`${a.label} · ${a.live.toLocaleString()} (${pct(a.live)}%)${a.pickable ? " — scope the report" : ""}`}
            className={`group flex items-center gap-1.5 text-xs ${a.pickable ? "" : "cursor-default"}`}>
            <span className="h-2 w-2 rounded-sm" style={{ background: a.color }} />
            <span className={`${hover === i ? "text-cream" : "text-cream/80"} ${a.pickable ? "group-hover:text-cream" : ""}`}>{a.label}</span>
            <span className="tabular-nums text-cream/40">{pct(a.live)}%</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const PERIODS = ["Day", "Week", "Month", "Quarter", "Year"] as const;
type Period = (typeof PERIODS)[number];
const PERIOD_DAYS: Record<Period, number> = { Day: 1, Week: 7, Month: 30, Quarter: 91, Year: 365 };
const PERIOD_KEY: Record<Period, "day" | "week" | "month" | "quarter" | "year"> =
  { Day: "day", Week: "week", Month: "month", Quarter: "quarter", Year: "year" };
const PERIOD_PREV: Record<Period, string> = { Day: "yesterday", Week: "last week", Month: "last month", Quarter: "last quarter", Year: "last year" };
const PERIOD_WORD: Record<Period, string> = { Day: "today", Week: "this week", Month: "this month", Quarter: "this quarter", Year: "this year" };
const TYPE_LABEL: Record<PayType, string> = { PSP: "Payment service providers", BNPL: "Buy now, pay later", APM: "Wallets & alternative methods" };
const TYPE_TONE: Record<PayType, string> = { PSP: "orange", BNPL: "mint", APM: "lilac" };

const daysAgo = (d: string) => (Date.now() - new Date(d).getTime()) / 864e5;
const fill = (tone: string) =>
  tone === "mint" ? "from-mint to-mint/45" : tone === "lilac" ? "from-lilac to-lilac/45" : tone === "cyan" ? "from-cyan to-cyan/45" : "from-orange to-orange/45";
const toneDot = (tone: string) =>
  tone === "mint" ? "bg-mint" : tone === "lilac" ? "bg-lilac" : tone === "cyan" ? "bg-cyan" : "bg-orange";
const toneText = (tone: string) =>
  tone === "mint" ? "text-mint" : tone === "lilac" ? "text-lilac" : tone === "cyan" ? "text-cyan" : "text-orange";

/** Bar track whose fill grows from 0 on mount — the shared "alive" animation. */
function AnimatedFill({ pct, tone }: { pct: number; tone: string }) {
  const [m, setM] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setM(true)));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-cream/[0.07]">
      <div
        className={`h-full rounded-full bg-gradient-to-r ${fill(tone)}`}
        style={{ width: m ? `${Math.min(pct, 100)}%` : "0%", transition: "width .9s cubic-bezier(.2,.8,.2,1)" }}
      />
    </div>
  );
}

/** Absolute change in store COUNT vs the comparison period (no % — a real number
 *  of stores). Shown on the distribution drill-ins so "change" is unambiguous. */
function CountDelta({ v }: { v: number | null }) {
  if (v === null) return <span className="text-cream/25">—</span>;
  if (v === 0) return <span className="text-cream/35">±0</span>;
  const up = v > 0;
  return (
    <span className={up ? "text-mint" : "text-orange"}>
      {up ? "▲+" : "▼−"}{Math.abs(v).toLocaleString()}
    </span>
  );
}

function TileDelta({ abs, pct }: { abs: number | null; pct: number | null }) {
  if (abs === null) return <span className="text-cream/25">—</span>;
  if (abs === 0) return <span className="text-cream/35">±0</span>;
  const up = abs > 0;
  return (
    <span className={up ? "text-mint" : "text-orange"}>
      {up ? "▲" : "▼"} {up ? "+" : "−"}{Math.abs(abs).toLocaleString()}
      {pct != null ? ` · ${Math.abs(pct)}%` : ""}
    </span>
  );
}

function Card({ title, subtitle, reportHref, accent, children }: { title: string; subtitle?: string; reportHref?: string; accent?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-cream/10 bg-cream/[0.02] p-5 transition hover:border-cream/15 md:p-6">
      <div className="flex items-center gap-2">
        {accent && <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${toneDot(accent)}`} />}
        {reportHref ? (
          <Link href={reportHref} className="group inline-flex items-baseline gap-1.5 font-semibold text-cream transition hover:text-cyan" title="Open the full report">
            {title}
            <span className="text-cream/25 transition group-hover:text-cyan/70">→</span>
          </Link>
        ) : (
          <h3 className="font-semibold text-cream">{title}</h3>
        )}
      </div>
      {subtitle && <p className="mt-1.5 text-xs leading-relaxed text-cream/45">{subtitle}</p>}
      <div className="mt-5">{children}</div>
    </div>
  );
}

function TrendLine({ data }: { data: number[] }) {
  const w = 520, h = 160;
  const max = Math.max(...data, 1);
  const step = w / Math.max(data.length - 1, 1);
  const pts = data.map((v, i) => [i * step, h - (v / max) * (h - 20)] as const);
  const line = pts.map((p) => p.join(",")).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full">
      <polygon points={`0,${h} ${line} ${w},${h}`} fill="var(--color-orange)" opacity="0.12" />
      <polyline points={line} fill="none" stroke="var(--color-orange)" strokeWidth="3" strokeLinejoin="round" />
      {pts.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="4" fill="var(--color-orange)" />)}
    </svg>
  );
}

/** A distribution (providers / themes / apps / categories) with % + absolute
 *  counts, drill-in to see every item, and per-item change vs the chosen period. */
// Drill-through link. Payment providers go to their DEDICATED PERFORMANCE PAGE (/p/[provider]) —
// insights should lead to deeper analysis, not back to the raw leads list. Everything else still
// pre-filters the Explorer for now (theme/category/app reports are a later step).
// The active CMS, so every drill/report link below carries ?platform= and the destination (a section
// report, a provider page, the Explorer) stays scoped to the CMS the user is looking at. Provided by
// InsightsView; "all" (the default) omits the param.
const PlatformCtx = createContext<string>("all");
const platformParam = (platform?: string) => (platform && platform !== "all" ? platform : null);

function drillHref(param: string, label: string, country?: string, platform?: string): string {
  const pf = platformParam(platform);
  if (param === "payment") {
    // Land on the ALL-MARKETS provider view (every country where the provider is used), then let the
    // user drill into a specific market from the page's country breakdown / dropdown. Deliberately
    // dropping the current country so a click always opens the full cross-market picture first.
    const q = new URLSearchParams();
    if (pf) q.set("platform", pf);
    const s = q.toString();
    return `/p/${encodeURIComponent(label)}${s ? `?${s}` : ""}`;
  }
  const p = new URLSearchParams();
  p.set(param, label);
  if (country) p.set("country", country);
  if (pf) p.set("platform", pf);
  return `/dashboard?${p.toString()}`;
}

function DistroCard({
  title, subtitle, data, baseline, tone = "orange", drillParam, country, reportHref, adopt, adoptWord,
}: {
  title: string;
  subtitle: string;
  data: InsightItem[];
  baseline: InsightItem[] | null;
  tone?: string;
  drillParam?: string;
  country?: string;
  reportHref?: string;
  // When given (a timeframe is active) the change column shows how many stores LAUNCHED in the
  // selected window with each value — real market movement — instead of the snapshot delta.
  adopt?: Record<string, number>;
  adoptWord?: string;
}) {
  const platform = useContext(PlatformCtx);
  const [all, setAll] = useState(false);
  const shown = all ? data : data.slice(0, 6);
  const bmap = baseline ? new Map(baseline.map((i) => [i.label, i.count])) : null;
  const showChange = adopt ? true : !!bmap;

  return (
    <Card title={title} subtitle={subtitle} reportHref={reportHref} accent={tone}>
      <div className={`space-y-2 ${all && data.length > 10 ? "max-h-96 overflow-y-auto pr-1" : ""}`}>
        {shown.map((i, idx) => {
          const prev = bmap?.get(i.label);
          const cdel = adopt ? (adopt[i.label] ?? 0) : prev != null ? i.count - prev : null;
          const leader = idx === 0;
          const cls = `group/row -mx-2 flex items-center gap-3 rounded-lg px-2 py-1.5 transition hover:bg-cream/[0.04] ${drillParam ? "cursor-pointer" : ""}`;
          const RowTag = (drillParam ? Link : "div") as React.ElementType;
          const rowProps = drillParam ? { href: drillHref(drillParam, i.label, country, platform) } : {};
          return (
            <RowTag key={i.label} {...rowProps} className={cls} title={`${i.label}: ${i.count.toLocaleString()} (${i.pct}%)${adopt ? ` — +${adopt[i.label] ?? 0} launched ${adoptWord ?? "this period"}` : ""}${drillParam ? " — click to view stores" : ""}`}>
              <span className={`w-4 shrink-0 text-right text-xs tabular-nums ${leader ? toneText(tone) : "text-cream/30"}`}>{idx + 1}</span>
              <div className={`w-28 shrink-0 truncate text-sm ${leader ? "text-cream" : "text-cream/75"} ${drillParam ? "group-hover/row:text-cream" : ""}`}>{i.label}</div>
              <AnimatedFill pct={i.pct} tone={tone} />
              <div className="w-10 shrink-0 text-right text-sm font-medium tabular-nums text-cream">{i.pct}%</div>
              <div className="w-12 shrink-0 text-right text-xs tabular-nums text-cream/40">{i.count.toLocaleString()}</div>
              {showChange && <div className="w-14 shrink-0 text-right text-xs tabular-nums" title={adopt ? `launched ${adoptWord ?? "this period"}` : undefined}>{<CountDelta v={cdel} />}</div>}
            </RowTag>
          );
        })}
      </div>
      {data.length > 6 && (
        <button
          onClick={() => setAll((a) => !a)}
          className="mt-4 text-xs font-medium text-cream/50 transition hover:text-cream"
        >
          {all ? "Show top 6" : `See all ${data.length} →`}
        </button>
      )}
    </Card>
  );
}

// WooCommerce-native sections — shown instead of the Shopify-shaped ones when the Woo platform
// is selected. Store status is the headline ("real store vs stale build"); the rest is the
// WP/Woo intel no competitor surfaces (hosting, versions, plugins).
const WOO_TIER: Record<string, { label: string; tone: string }> = {
  selling: { label: "Selling (has sales/reviews)", tone: "mint" },
  active: { label: "Active (live, stocked)", tone: "cyan" },
  dormant: { label: "Dormant (built, not selling)", tone: "orange" },
  not_a_store: { label: "Not a store (parked)", tone: "lilac" },
};
function WooSections({ woo }: { woo: NonNullable<InsightsData["woo"]> }) {
  const realN = woo.statusTiers.filter((t) => t.label === "selling" || t.label === "active").reduce((s, t) => s + t.count, 0);
  const status = woo.statusTiers.map((t) => ({ ...t, label: WOO_TIER[t.label]?.label ?? t.label }));
  return (
    <>
      <DistroCard
        title="Store status"
        subtitle={`${woo.total.toLocaleString()} confirmed WooCommerce stores · ${realN.toLocaleString()} actually selling/active — the rest are parked or stale builds`}
        data={status} baseline={null} tone="mint"
      />
      <DistroCard title="Hosting provider" subtitle="Where these stores are hosted — ASN-resolved (a market no one else surfaces)" data={woo.hosting} baseline={null} tone="cyan" />
      <DistroCard title="WooCommerce version" subtitle="Which WooCommerce release these stores run" data={woo.wooVersions} baseline={null} tone="lilac" />
      <DistroCard title="WordPress version" subtitle="Which WordPress version these stores run" data={woo.wpVersions} baseline={null} tone="orange" />
      <DistroCard title="Top plugins" subtitle="Most-installed WordPress plugins across these stores" data={woo.plugins} baseline={null} tone="mint" />
      {/* Payment gateways now render via the segmented PSP/BNPL/APM PaymentIntelligenceCard above
          (checkout-verified), replacing the old flat plugin-derived list. */}
    </>
  );
}

// Magento / Adobe Commerce sections — the version spread (like Woo's) + where they're hosted.
// Payments render via the shared PaymentIntelligenceCard above.
function MagentoSections({ magento }: { magento: NonNullable<InsightsData["magento"]> }) {
  return (
    <>
      <DistroCard title="Magento version" subtitle={`Which Magento / Adobe Commerce release these ${magento.total.toLocaleString()} stores run`} data={magento.versions} baseline={null} tone="lilac" />
      <DistroCard title="Hosting provider" subtitle="Where these stores are hosted — ASN-resolved" data={magento.hosting} baseline={null} tone="cyan" />
    </>
  );
}

/** Payment intelligence — providers split into PSP / BNPL / APM, each drillable, with the
 *  headline BNPL/PSP signals. Used on BOTH the Shopify and WooCommerce views (Woo now has real
 *  checkout-verified payment data), so a payment company sees the same breakdown per platform. */
function PaymentIntelligenceCard({
  data, provByType, baseProvByType, base, windowed, pk, pw, country, subtitle,
}: {
  data: InsightsData;
  provByType: Record<PayType, InsightItem[]>;
  baseProvByType: Record<PayType, InsightItem[]> | null;
  base: InsightsData | null;
  windowed: boolean;
  pk: "day" | "week" | "month" | "quarter" | "year";
  pw: string;
  country: string;
  subtitle?: string;
}) {
  const platform = useContext(PlatformCtx);
  const pfx = platformParam(platform) ? `&platform=${platformParam(platform)}` : "";
  return (
    <Card
      title="Payment intelligence"
      subtitle={subtitle ?? (windowed
        ? `What the ${data.launchedByPeriod[pk].toLocaleString()} stores that launched ${pw} chose at checkout — the newest-store cohort`
        : `Checkout-verified on ${data.coverage.paymentPct}% of live stores (${data.paymentsVerifiedStores.toLocaleString()} of ${data.coverage.paymentReachable.toLocaleString()})`)}
      reportHref={`/insights/payments?country=${country}${pfx}`}
    >
      {/* Headline signals — all-time store-level type coverage; hidden in a launch window (where we
          only have the cohort's provider counts, not store-level PSP/BNPL overlap). */}
      {!windowed && (
      <div className="mb-6 grid grid-cols-3 gap-3">
        {[
          { n: `${data.paymentsByType.BNPL.pct}%`, l: "offer BNPL" },
          { n: (data.paymentsVerifiedStores - data.paymentsByType.BNPL.count).toLocaleString(), l: "no BNPL yet" },
          { n: `${data.paymentsByType.PSP.pct}%`, l: "use a PSP" },
        ].map((s) => (
          <div key={s.l} className="rounded-2xl border border-cream/10 bg-cream/[0.02] p-3 text-center">
            <div className="font-display text-2xl text-cream">{s.n}</div>
            <div className="mt-0.5 text-[11px] uppercase tracking-wide text-cream/45">{s.l}</div>
          </div>
        ))}
      </div>
      )}
      <div className="space-y-7">
        {PAY_TYPES.map((t) =>
          provByType[t].length ? (
            <div key={t}>
              <div className="mb-3 flex flex-wrap items-baseline gap-x-2">
                <span className="text-xs font-bold uppercase tracking-wide text-cream/80">{t}</span>
                <span className="text-[11px] text-cream/40">
                  {TYPE_LABEL[t]}{!windowed && <> · {data.paymentsByType[t].pct}% of stores ({data.paymentsByType[t].count.toLocaleString()})</>}
                </span>
              </div>
              <DrillList data={provByType[t]} baseline={baseProvByType?.[t] ?? null} tone={TYPE_TONE[t]} showBaseline={!!base} drillParam="payment" country={country} />
            </div>
          ) : null,
        )}
      </div>
    </Card>
  );
}

// Time-period presets (best practice): relative windows for "how are we doing lately" + calendar
// periods for reporting, each resolving to an absolute [from,to] that drives the growth chart.
// Grouped so the dropdown reads clearly. "Custom" / "All time" clear the range.
const DATE_PRESETS: { key: string; label: string; group: string }[] = [
  { key: "", label: "All time", group: "" },
  { key: "7d", label: "Last 7 days", group: "Recent" },
  { key: "30d", label: "Last 30 days", group: "Recent" },
  { key: "90d", label: "Last 90 days", group: "Recent" },
  { key: "12mo", label: "Last 12 months", group: "Recent" },
  { key: "thisMonth", label: "This month", group: "Calendar" },
  { key: "lastMonth", label: "Last month", group: "Calendar" },
  { key: "thisQuarter", label: "This quarter", group: "Calendar" },
  { key: "lastQuarter", label: "Last quarter", group: "Calendar" },
  { key: "ytd", label: "Year to date", group: "Calendar" },
  { key: "q1", label: "Q1", group: "Quarters" }, { key: "q2", label: "Q2", group: "Quarters" },
  { key: "q3", label: "Q3", group: "Quarters" }, { key: "q4", label: "Q4", group: "Quarters" },
];
function presetRange(key: string): { from: string; to: string } {
  const now = new Date();
  const y = now.getUTCFullYear(), m = now.getUTCMonth(), q = Math.floor(m / 3);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const som = (yy: number, mm: number) => iso(new Date(Date.UTC(yy, mm, 1)));
  const eom = (yy: number, mm: number) => iso(new Date(Date.UTC(yy, mm + 1, 0)));
  const ago = (days: number) => iso(new Date(Date.now() - days * 864e5));
  switch (key) {
    case "7d": return { from: ago(7), to: iso(now) };
    case "30d": return { from: ago(30), to: iso(now) };
    case "90d": return { from: ago(90), to: iso(now) };
    case "12mo": return { from: iso(new Date(Date.UTC(y - 1, m, now.getUTCDate()))), to: iso(now) };
    case "thisMonth": return { from: som(y, m), to: iso(now) };
    case "lastMonth": return { from: som(y, m - 1), to: eom(y, m - 1) };
    case "thisQuarter": return { from: som(y, q * 3), to: iso(now) };
    case "lastQuarter": { const py = q === 0 ? y - 1 : y, pq = q === 0 ? 3 : q - 1; return { from: som(py, pq * 3), to: eom(py, pq * 3 + 2) }; }
    case "ytd": return { from: som(y, 0), to: iso(now) };
    case "q1": return { from: som(y, 0), to: eom(y, 2) };
    case "q2": return { from: som(y, 3), to: eom(y, 5) };
    case "q3": return { from: som(y, 6), to: eom(y, 8) };
    case "q4": return { from: som(y, 9), to: eom(y, 11) };
    default: return { from: "", to: "" };
  }
}

export function InsightsView({
  data, history, baselineDate, countries = [], country = "ZA", cohorts = [], tag = "",
  platform = "all", platforms = [], momentumByPeriod, shifts = [],
}: {
  data: InsightsData;
  history: InsightsData[];
  baselineDate?: string | null;
  countries?: { country: string; stores: number }[];
  country?: string;
  cohorts?: { tag: string; count: number }[];
  tag?: string;
  platform?: PlatformSel;
  platforms?: { platform: string; live: number }[];
  momentumByPeriod?: Record<"day" | "week" | "month" | "quarter" | "year", ProviderMomentum[]>;
  shifts?: PaymentShift[];
}) {
  // Soft-navigate (keeps the current data on screen, dimmed, while the new data loads) and mark
  // the transition pending so the UI shows IMMEDIATE feedback on any filter click — the #1 thing
  // that was missing. loading.tsx covers the first load / hard reloads.
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const go = (next: { country?: string; tag?: string; platform?: string }) => {
    const c = next.country ?? country;
    const t = next.tag ?? tag;
    const pf = next.platform ?? platform;
    const qs = new URLSearchParams();
    if (c) qs.set("country", c);
    if (t) qs.set("tag", t);
    if (pf && pf !== "all") qs.set("platform", pf);
    startTransition(() => router.push(`/insights?${qs.toString()}`));
  };
  // ONE report lens replaces the old split Timeframe-buttons + Period-range controls: either the
  // live-market snapshot ("current", the default) or a launch WINDOW that re-scopes EVERY breakdown
  // below to the stores that launched in it — the newest-store cohort. (Data: data.launchedDistro.)
  const [lens, setLens] = useState<"current" | Period>("current");
  const windowed = lens !== "current";
  const period: Period = windowed ? lens : "Month"; // "Month" = default granularity for the flow cards when current
  const pk = PERIOD_KEY[period];
  const pw = windowed ? `in the last ${PERIOD_DAYS[period]} days` : PERIOD_WORD[period];

  // Trends/comparisons only look back to the baseline (reset after a bulk import
  // so the batch doesn't skew growth or forward-churn).
  const effHistory = baselineDate ? history.filter((h) => h.date >= baselineDate) : history;

  // A snapshot at least this far back powers the over-time COMPARISON deltas (tiles' vs-last-period
  // numbers). It's no longer a gate on selecting the period: the timeframe now also drives the
  // launch-date breakdowns (always computed fresh), so every period is selectable — the comparison
  // just fills in once enough daily snapshots exist.
  const baselineFor = (p: Period): InsightsData | null => {
    const want = PERIOD_DAYS[p];
    const older = effHistory.filter((h) => h.date !== data.date && daysAgo(h.date) >= want);
    return older.length ? older[older.length - 1] : null;
  };
  const hasComparison = (p: Period) => baselineFor(p) !== null;
  // Snapshot-vs-previous-period deltas apply only to the live "current" view; a launch WINDOW is
  // self-contained (the whole card IS the cohort), so it carries no baseline delta.
  const base = !windowed && hasComparison(period) ? baselineFor(period) : null;
  // Absolute + % change of a metric vs the selected period's baseline.
  const metric = (key: keyof InsightsData): { abs: number | null; pct: number | null } => {
    const b = base && typeof base[key] === "number" ? (base[key] as number) : null;
    if (b == null) return { abs: null, pct: null };
    const abs = (data[key] as number) - b;
    return { abs, pct: b > 0 ? Math.round((100 * abs) / b) : null };
  };

  const plusTrend = effHistory.length >= 2 ? effHistory.map((h) => h.plusTotal) : null;

  // Group providers by PSP / BNPL / APM for the segmented payment breakdown.
  const groupByType = (list?: InsightItem[]): Record<PayType, InsightItem[]> => {
    const g: Record<PayType, InsightItem[]> = { PSP: [], BNPL: [], APM: [] };
    for (const p of list ?? []) g[classify(p.label)].push(p);
    return g;
  };
  // In a launch WINDOW every distribution becomes that cohort's (launchedDistro = label→count per
  // period); otherwise each card shows the live snapshot. `distro()` picks the right source per card.
  const toItems = (rec?: Record<string, number>): InsightItem[] => {
    const e = Object.entries(rec ?? {});
    const tot = e.reduce((s, [, n]) => s + n, 0) || 1;
    return e.map(([label, count]) => ({ label, count, pct: Math.round((100 * count) / tot) })).sort((a, b) => b.count - a.count);
  };
  const wd = windowed ? data.launchedDistro[pk] : null;
  const distro = (key: DistroKey, allTime: InsightItem[]): InsightItem[] => (wd ? toItems(wd[key]) : allTime);
  const cohortN = windowed ? data.launchedByPeriod[pk] : 0;
  // Window-aware "Of N stores" subtitle for the distribution cards.
  const distroSub = (allTime: string) => (windowed ? `Of ${cohortN.toLocaleString()} stores launched ${pw}` : allTime);
  const provByType = groupByType(distro("payments", data.paymentsByProvider));
  const baseProvByType = base ? groupByType(base.paymentsByProvider) : null;

  // Provider momentum follows the timeframe selector: newly-launched stores this period vs the
  // previous period of the same length.
  const momentum = momentumByPeriod?.[pk] ?? [];
  const cov = data.coverage;
  const covPctOf = (n: number, d: number) => (d > 0 ? Math.round((100 * n) / d) : 0);
  // TRACK A — OUR COVERAGE: how complete + fresh OUR dataset is (progress, always improving).
  const coverageTiles = [
    { n: cov.tracked.toLocaleString(), label: "stores tracked", sub: "in our dataset" },
    { n: cov.live.toLocaleString(), label: "verified live", sub: `${covPctOf(cov.live, cov.tracked)}% of tracked` },
    { n: `${covPctOf(cov.checked30d, cov.tracked)}%`, label: "scan freshness", sub: "checked ≤ 30 days" },
    { n: `${cov.paymentPct}%`, label: "payment coverage", sub: `of ${cov.live.toLocaleString()} live` },
    { n: `${cov.launchPct}%`, label: "launch-date coverage", sub: "of tracked" },
  ];

  const pfx = platformParam(platform) ? `&platform=${platformParam(platform)}` : "";
  return (
    <PlatformCtx.Provider value={platform}>
    <div>
      {/* Indeterminate top bar + dim while a filter change is loading — immediate feedback. */}
      {pending && (
        <div className="fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden bg-cyan/20" aria-hidden>
          <div className="h-full w-1/3 animate-[insLoad_1s_ease-in-out_infinite] bg-cyan" />
          <style>{`@keyframes insLoad{0%{transform:translateX(-100%)}100%{transform:translateX(400%)}}`}</style>
        </div>
      )}
      <div className={`mx-auto max-w-6xl transition-opacity duration-200 ${pending ? "pointer-events-none opacity-50" : ""}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <InsightsNav active="Markets" />
          <span className="shrink-0 rounded-full border border-mint/25 bg-mint/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-mint">Live data</span>
        </div>

        <header className="mt-6">
          <h1 className="font-display text-4xl md:text-5xl">Market Insights</h1>
          <p className="mt-2 max-w-2xl text-cream/60">
            {tag === "new"
              ? <>What the newest {marketAdjective(country)} stores are choosing — </>
              : tag
                ? <>The {marketAdjective(country)} <b className="text-cream">{tagLabel(tag)}</b> — </>
                : <>Where the {marketAdjective(country)} {platform === "all" ? "ecommerce" : platformLabel(platform)} market is heading — </>}
            payment stacks, themes, apps, categories and enterprise adoption, from {data.storesTotal.toLocaleString()}{" "}
            {tag === "new" ? "stores found in the last 90 days" : tag ? "stores in this cohort" : "live stores we track"}.
          </p>
        </header>

        {/* filters */}
        <div className="mt-6 flex flex-wrap items-center gap-6 rounded-3xl border border-cream/12 bg-cream/[0.03] px-5 py-4">
          {countries.length > 1 && (
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-cream/40">Market</span>
              <select
                value={country}
                onChange={(e) => go({ country: e.target.value })}
                className="rounded-full border border-cream/15 bg-transparent px-4 py-1.5 text-sm text-cream outline-none focus:border-cream/50 [&>optgroup]:bg-ink-deep [&>option]:bg-ink-deep"
              >
                {groupByRegion(countries).map(({ region, items }) => (
                  <optgroup key={region} label={region}>
                    {items.map((c) => (
                      <option key={c.country} value={c.country} className="text-ink">
                        {marketLabel(c.country)} ({c.stores.toLocaleString()})
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
          )}
          {cohorts.some((c) => c.count > 0) && (
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-cream/40">Cohort</span>
              <select
                value={tag}
                onChange={(e) => go({ tag: e.target.value })}
                className="rounded-full border border-cream/15 bg-transparent px-4 py-1.5 text-sm text-cream outline-none focus:border-cream/50"
              >
                <option value="" className="text-ink">All stores</option>
                {cohorts.filter((c) => c.count > 0).map((c) => (
                  <option key={c.tag} value={c.tag} className="text-ink">
                    {tagLabel(c.tag)} ({c.count.toLocaleString()})
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-cream/40">Platform</span>
            {/* Data-driven dropdown: "All" + every CMS with a live presence in this market
                (availablePlatforms). Selecting one re-scopes the ENTIRE report to that platform
                (go() sets ?platform= and the server recomputes every distribution for it). */}
            <select
              value={platform}
              onChange={(e) => go({ platform: e.target.value })}
              className="rounded-full border border-cream/15 bg-transparent px-4 py-1.5 text-sm text-cream outline-none focus:border-cream/50 [&>option]:bg-ink-deep"
            >
              <option value="all" className="text-ink">All platforms</option>
              {platforms.map(({ platform: key, live }) => (
                <option key={key} value={key} className="text-ink">
                  {platformLabel(key)} ({live.toLocaleString()})
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-cream/40">View</span>
            {/* ONE lens as small buttons (default Current): the live market, OR a launch window that
                re-scopes EVERY breakdown below to the stores that launched in it — the newest cohort. */}
            {([["current", "Current"], ["Week", "7d"], ["Month", "30d"], ["Quarter", "90d"], ["Year", "12mo"]] as const).map(([val, lbl]) => (
              <button key={val} onClick={() => setLens(val)}
                title={val === "current" ? "The full live market" : `Stores that launched in the last ${lbl}`}
                className={`rounded-full px-3 py-1 text-xs transition ${lens === val ? "bg-orange text-cream" : "border border-cream/15 text-cream/55 hover:border-cream/40"}`}>
                {lbl}
              </button>
            ))}
            <span className="ml-1 hidden text-xs text-cream/40 lg:inline">
              {windowed ? `the ${cohortN.toLocaleString()} newest stores` : "the full live market"}
            </span>
          </div>
        </div>
        {windowed && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-2xl border border-orange/25 bg-orange/[0.06] px-4 py-2.5 text-sm text-cream/80">
            <span className="shrink-0 rounded-full bg-orange/20 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-orange">New-store cohort</span>
            <span>Every breakdown below is the <b className="text-cream">{cohortN.toLocaleString()}</b> stores that launched {pw} — what the newest {marketLabel(country)} {platform === "all" ? "" : platformLabel(platform) + " "}stores are choosing, not the full live market.</span>
            <button onClick={() => setLens("current")} className="ml-auto shrink-0 text-xs font-medium text-cyan hover:underline">← Back to current market</button>
          </div>
        )}

        {/* ── TRACK A · OUR COVERAGE — dataset progress, NOT market movement ─────────── */}
        <div className="mt-7">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-cyan">Our coverage</h2>
            <span className="text-xs text-cream/40">how complete &amp; fresh our dataset is — our platform&rsquo;s progress, not the market</span>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 md:grid-cols-5">
            {coverageTiles.map((s) => (
              <div key={s.label} className="rounded-2xl border border-cream/10 bg-cream/[0.02] px-5 py-5 text-cream transition hover:border-cream/20">
                <div className="font-display text-4xl leading-none tabular-nums">{s.n}</div>
                <div className="mt-2 text-xs font-medium uppercase tracking-wide text-cream/45">{s.label}</div>
                {s.sub && <div className="mt-0.5 text-[11px] text-cream/35">{s.sub}</div>}
              </div>
            ))}
          </div>
        </div>

        {/* The old "Market movement" tiles were removed — redundant with the Launches & churn chart
            below, which shows the same launch/churn on the market's clock, over time. */}

        {/* PLATFORM MIX — every CMS we track live in this market, by store count. Answers "show all the
            CMSs" directly (the growth chart below can only plot a trajectory where stores are
            launch-dated). Each row re-scopes the whole report to that platform, like the dropdown. */}
        {platform === "all" && platforms.length > 0 && (() => {
          const totalLive = platforms.reduce((s, p) => s + p.live, 0) || 1;
          const TOP = 6;
          const top = platforms.slice(0, TOP);
          const restLive = platforms.slice(TOP).reduce((s, p) => s + p.live, 0);
          const lp = data.launchedByPeriod;
          const launchRows = [["Week", "7 days", lp.week], ["Month", "30 days", lp.month], ["Quarter", "90 days", lp.quarter], ["Year", "12 months", lp.year]] as const;
          const relMax = Math.max(...launchRows.map((r) => r[2]), 1);
          const donutSlices = [
            ...top.map((p) => ({ key: p.platform, label: platformLabel(p.platform), live: p.live, color: platformDot(p.platform), pickable: true })),
            ...(restLive > 0 ? [{ key: "__other", label: "Other", live: restLive, color: "#5b6b70", pickable: false }] : []),
          ];
          return (
            <div className="mt-8 grid gap-5 md:grid-cols-2">
              {/* Platform mix — donut; hover a slice/legend for store count + share, click to scope */}
              <div className="rounded-2xl border border-cream/10 bg-cream/[0.02] p-5 md:p-6">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="font-semibold text-cream">Platform mix</h3>
                  <span className="text-xs text-cream/40">{totalLive.toLocaleString()} live · {marketLabel(country)}</span>
                </div>
                <div className="mt-4">
                  <PlatformDonut slices={donutSlices} totalLive={totalLive} onPick={(k) => go({ platform: k })} />
                </div>
              </div>
              {/* New launches — growth of newly-launched stores by window; the active View is highlighted */}
              <div className="rounded-2xl border border-cream/10 bg-cream/[0.02] p-5 md:p-6">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="font-semibold text-cream">New launches</h3>
                  <span className="text-xs text-cream/40">stores launched, by window</span>
                </div>
                <div className="mt-4 space-y-1">
                  {launchRows.map(([val, lbl, n]) => {
                    const active = lens === val;
                    return (
                      <button key={val} onClick={() => setLens(val)} title={`Scope the report to stores launched in the last ${lbl}`}
                        className={`flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition ${active ? "bg-orange/10 ring-1 ring-orange/25" : "hover:bg-cream/[0.04]"}`}>
                        <span className={`w-16 shrink-0 text-xs ${active ? "font-semibold text-cream" : "text-cream/70"}`}>{lbl}</span>
                        <span className="relative h-2 flex-1 overflow-hidden rounded-full bg-cream/[0.06]">
                          <span className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-mint to-mint/45" style={{ width: `${Math.max(2, (n / relMax) * 100)}%` }} />
                        </span>
                        <span className="w-16 shrink-0 text-right text-sm tabular-nums text-cream">{n.toLocaleString()}</span>
                      </button>
                    );
                  })}
                </div>
                <p className="mt-3 text-[11px] text-cream/35">Click a window to re-scope every breakdown to that new-store cohort.</p>
              </div>
            </div>
          );
        })()}

        <div className="mt-8 grid gap-5 md:grid-cols-2">
          {/* New launches vs churn per period (diverging bars). On the combined "all" view this is
              all-ecommerce; the cumulative Shopify-vs-Woo trajectory sits beside it below. */}
          <GrowthChart country={country} platform={platform} period={PERIOD_KEY[period]} title={`${country ? marketLabel(country) + " " : ""}${platform === "all" ? "all-ecommerce" : platformLabel(platform)} launches & churn`.replace(/\s+/g, " ")} />

          {/* Combined view only: cumulative growth split by platform, so you can see whether Woo or
              Shopify is growing faster (hover a legend chip for its selling/active/dormant split). */}
          {platform === "all" && <PlatformGrowthChart country={country} />}

          {/* WooCommerce now has real checkout-verified payment data — show the SAME PSP/BNPL/APM
              breakdown as Shopify (its own Woo sections still follow below). */}
          {platform === "woocommerce" && (
            <PaymentIntelligenceCard data={data} provByType={provByType} baseProvByType={baseProvByType} base={base} windowed={windowed} pk={pk} pw={pw} country={country} />
          )}

          {/* Shopify payment intelligence — hidden on the WooCommerce view (its own sections below) */}
          {platform !== "woocommerce" && (<>
          {/* Payment providers — broken out by PSP / BNPL / APM, each drillable */}
          <PaymentIntelligenceCard data={data} provByType={provByType} baseProvByType={baseProvByType} base={base} windowed={windowed} pk={pk} pw={pw} country={country} />

          <div className="space-y-5">
            {/* Shopify Plus is a Shopify-only concept — hide it on the combined "all" view (there it
                would mix an enterprise-Shopify signal into an all-ecommerce dashboard). */}
            {platform === "shopify" && (
            <Card title="Shopify Plus adoption" subtitle="Cumulative total over time" reportHref={`/dashboard?plus=true&country=${country}${pfx}`}>
              {plusTrend ? <TrendLine data={plusTrend} /> : (
                <div className="grid h-32 place-items-center rounded-2xl border border-dashed border-cream/12 text-sm text-cream/40">
                  Trend builds as daily snapshots accumulate
                </div>
              )}
              <p className="pt-3 text-sm text-cream/45">
                {data.plusNewThisWeek} new this week · {data.plusTotal} total.
              </p>
            </Card>
            )}
            <Card title="Leading provider at checkout" subtitle="First gateway offered (best-effort)" reportHref={`/insights/leading?country=${country}${pfx}`}>
              <DrillList data={distro("leading", data.firstProvider)} baseline={base?.firstProvider ?? null} tone="orange" showBaseline={!!base} drillParam="payment" country={country} />
            </Card>
          </div>

          {/* Provider momentum + live switch feed — the "internal shifts" view. Fills
              from daily snapshots (share/rank movement) and the 60-day re-probe cycle
              (per-store switches), so it deepens over time. */}
          <div className="mt-4 grid gap-5 md:grid-cols-1">
            <Card
              title="Provider momentum"
              subtitle={`Which PSPs newly-launched stores are choosing — ${pw} vs ${PERIOD_PREV[period]}`}
              reportHref={`/insights/payments?country=${country}${pfx}`}
            >
              {/* Say exactly what's compared — this follows the Timeframe selector above. */}
              <div className="mb-4 rounded-xl bg-cream/[0.04] px-3 py-2 text-[11px] leading-relaxed text-cream/55">
                Comparing stores <b className="text-cream/85">launched in the last {PERIOD_DAYS[period]} days</b> against the <b className="text-cream/85">previous {PERIOD_DAYS[period]} days</b>. <span className="text-cream/70">Δ share</span> = the change in each gateway&rsquo;s share of those new stores. Change the <b className="text-cream/85">Timeframe</b> above to compare other windows.
              </div>
              {momentum.length ? (
                <div>
                  {/* labelled columns so the numbers read without hovering */}
                  <div className="mb-2 flex items-center gap-3 border-b border-cream/10 pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-cream/35">
                    <span className="flex-1">Provider</span>
                    <span className="w-14 text-right">Share</span>
                    <span className="w-16 text-right">Δ share</span>
                    <span className="w-12 text-right">New</span>
                  </div>
                  <ul className="space-y-2.5">
                    {momentum.slice(0, 8).map((m) => (
                      <li key={m.provider}>
                        <div className="flex items-center gap-3 text-sm">
                          <Link href={drillHref("payment", m.provider, country, platform)} className="flex-1 truncate text-cream/85 hover:text-cream hover:underline">{m.provider}</Link>
                          <span className="w-14 text-right tabular-nums text-cream/70">{m.share}%</span>
                          <span className={`w-16 text-right text-xs tabular-nums ${m.shareDelta > 0 ? "text-mint" : m.shareDelta < 0 ? "text-orange" : "text-cream/25"}`}>
                            {m.shareDelta > 0 ? "▲" : m.shareDelta < 0 ? "▼" : "·"} {m.shareDelta > 0 ? "+" : ""}{m.shareDelta}pt
                          </span>
                          <span className="w-12 text-right text-xs tabular-nums text-cream/50">{m.total}{m.totalDelta !== 0 && <span className={m.totalDelta > 0 ? "text-mint/70" : "text-orange/70"}> {m.totalDelta > 0 ? "+" : ""}{m.totalDelta}</span>}</span>
                        </div>
                        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-cream/[0.07]">
                          <div className="h-full rounded-full bg-cyan/50" style={{ width: `${Math.max(2, Math.min(100, m.share))}%` }} />
                        </div>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-3 text-[11px] text-cream/35">&ldquo;New&rdquo; = stores that launched in the window with each gateway. Share is of all payment-verified stores launched in the window.</p>
                </div>
              ) : (
                <p className="text-sm text-cream/40">Not enough stores launched in this window yet — try a longer timeframe (recent launches also lag until each store is payment-verified).</p>
              )}
            </Card>
            <Card title="Recent provider switches" subtitle="Stores that added or dropped a gateway — latest change per store" reportHref={`/insights/switches?country=${country}${pfx}`}>
              {shifts.length ? (
                <ul className="divide-y divide-cream/[0.06]">
                  {shifts.slice(0, 8).map((s, i) => {
                    const swap = s.added.length === 1 && s.removed.length === 1; // clean A→B switch
                    return (
                      <li key={i} className="py-3">
                        {/* Lead with WHAT CHANGED — that's the signal; domain + date are metadata. */}
                        <div className="flex flex-wrap items-center gap-1.5 text-sm">
                          {swap ? (
                            <>
                              <Link href={drillHref("payment", s.removed[0], country, platform)} className="text-orange/75 line-through decoration-orange/40 hover:text-orange">{s.removed[0]}</Link>
                              <span className="text-cream/30">→</span>
                              <Link href={drillHref("payment", s.added[0], country, platform)} className="font-semibold text-mint hover:underline">{s.added[0]}</Link>
                            </>
                          ) : (
                            <>
                              {s.added.map((a) => (
                                <Link key={`a${a}`} href={drillHref("payment", a, country, platform)} className="rounded bg-mint/15 px-2 py-0.5 text-xs font-medium text-mint hover:bg-mint/25">+ {a}</Link>
                              ))}
                              {s.removed.map((r) => (
                                <Link key={`r${r}`} href={drillHref("payment", r, country, platform)} className="rounded bg-orange/15 px-2 py-0.5 text-xs font-medium text-orange hover:bg-orange/25">− {r}</Link>
                              ))}
                            </>
                          )}
                        </div>
                        <div className="mt-1 flex items-baseline justify-between gap-2 text-[11px] text-cream/35">
                          <a href={`https://${s.domain}`} target="_blank" rel="noopener noreferrer"
                            className="truncate font-mono hover:text-cream hover:underline">{s.domain}</a>
                          <span className="shrink-0 tabular-nums">{s.changedAt}</span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-sm text-cream/40">No switches logged yet — detected as stores are re-probed on the 60-day cycle.</p>
              )}
            </Card>
          </div>
          </>)}

          {/* WooCommerce-native sections — store status, hosting, versions, plugins, gateways */}
          {platform === "woocommerce" && data.woo && <WooSections woo={data.woo} />}

          {/* Magento / Adobe Commerce version + hosting — surfaced like Woo's version card */}
          {platform === "magento" && data.magento && <MagentoSections magento={data.magento} />}

          {platform !== "woocommerce" && (<>
          {/* Cross-platform distributions — meaningful on the combined "all" view too. */}
          <DistroCard title="Categories" subtitle={distroSub(`Of ${data.categoriesKnown.toLocaleString()} categorised stores`)} data={distro("categories", data.categories)} baseline={base?.categories ?? null} tone="cyan" drillParam="category" country={country} reportHref={`/insights/categories?country=${country}${pfx}`} />
          {/* Themes + apps are SHOPIFY-specific (Shopify has no cross-platform equivalent), so they
              only appear when the Shopify platform is selected — not on the combined "all" view. */}
          {platform === "shopify" && (<>
          <DistroCard title="Theme market share" subtitle={distroSub(`Of ${data.themesKnown.toLocaleString()} stores with a known theme`)} data={distro("themes", data.themes)} baseline={base?.themes ?? null} tone="mint" drillParam="theme" country={country} reportHref={`/insights/themes?country=${country}${pfx}`} />
          <DistroCard title="Top apps installed" subtitle={distroSub(`Of ${data.appsKnown.toLocaleString()} stores with app data`)} data={distro("apps", data.apps)} baseline={base?.apps ?? null} tone="lilac" reportHref={`/insights/apps?country=${country}${pfx}`} />
          </>)}
          <DistroCard title="Cities" subtitle={distroSub(`Of ${data.citiesKnown.toLocaleString()} stores with a location`)} data={distro("cities", data.cities)} baseline={base?.cities ?? null} tone="orange" drillParam="city" country={country} reportHref={`/insights/cities?country=${country}${pfx}`} />
          <DistroCard
            title="Shipping providers"
            subtitle={distroSub(`Checkout-verified on ${data.shippingKnown.toLocaleString()} stores · ${data.shippingKnown ? Math.round((100 * data.freeShippingStores) / data.shippingKnown) : 0}% offer free shipping`)}
            data={distro("shipping", data.shippingByProvider)}
            baseline={base?.shippingByProvider ?? null}
            tone="cyan"
            drillParam="shipping"
            country={country}
            reportHref={`/insights/shipping?country=${country}${pfx}`}
          />
          </>)}
        </div>

        {/* Platform migrations — net movement between CMSs (live_platform vs where we first found the
            store). HIDDEN for now (doesn't look right yet); data + section kept, flip to re-enable. */}
        {false && data.migrations.length > 0 && (() => {
          const maxAbs = Math.max(...data.migrations.map((m) => Math.abs(m.net)), 1);
          const totalMoved = data.migrations.reduce((s, m) => s + m.gained, 0);
          return (
            <section className="mt-10">
              <div className="mb-3 flex items-baseline justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-cream/50">Platform migrations</h2>
                <span className="text-xs text-cream/35">{totalMoved.toLocaleString()} {marketLabel(country)} stores changed platform · net gained vs lost</span>
              </div>
              <div className="rounded-2xl border border-cream/10 bg-cream/[0.02] p-5 md:p-6">
                <div className="space-y-1.5">
                  {data.migrations.map((m) => {
                    const pos = m.net >= 0;
                    return (
                      <div key={m.platform} className="flex items-center gap-3">
                        <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: platformDot(m.platform) }} />
                        <span className="w-28 shrink-0 truncate text-sm text-cream/80">{platformLabel(m.platform)}</span>
                        <div className="relative h-2 flex-1">
                          <div className="absolute inset-y-0 left-1/2 w-px bg-cream/15" />
                          <div className={`absolute inset-y-0 rounded-full ${pos ? "bg-mint" : "bg-orange"}`}
                            style={pos ? { left: "50%", width: `${(m.net / maxAbs) * 50}%` } : { right: "50%", width: `${(-m.net / maxAbs) * 50}%` }} />
                        </div>
                        <span className={`w-16 shrink-0 text-right text-sm tabular-nums ${pos ? "text-mint" : "text-orange"}`}>{pos ? "+" : "−"}{Math.abs(m.net).toLocaleString()}</span>
                        <span className="hidden w-24 shrink-0 text-right text-[11px] tabular-nums text-cream/35 sm:inline">+{m.gained.toLocaleString()} / −{m.lost.toLocaleString()}</span>
                      </div>
                    );
                  })}
                </div>
                <p className="mt-4 text-[11px] leading-relaxed text-cream/35">
                  A store counts as migrated when its live platform differs from where we first found it. Net = stores gained minus lost; the +/− column is the raw inflow/outflow. (WordPress ≈ self-hosted WooCommerce.)
                </p>
              </div>
            </section>
          );
        })()}

        <p className="mt-8 text-center text-xs text-cream/40">
          Live Terrain data · {data.date} · {data.storesTotal.toLocaleString()} live South African stores
        </p>
      </div>
    </div>
    </PlatformCtx.Provider>
  );
}

/** Compact drill-in list (used inside the payments cards). When `adopt` is given, the
 *  change column shows GENUINE ADOPTIONS this period (discovery-neutral) instead of the
 *  snapshot delta — so enrichment/vetting of old stores never inflates it. */
function DrillList({
  data, baseline, tone, showBaseline, drillParam, country, adopt, adoptWord,
}: {
  data: InsightItem[];
  baseline: InsightItem[] | null;
  tone: string;
  showBaseline: boolean;
  drillParam?: string;
  country?: string;
  // stores that LAUNCHED in the selected window with each provider (real market movement)
  adopt?: Record<string, number>;
  adoptWord?: string;
}) {
  const platform = useContext(PlatformCtx);
  const [all, setAll] = useState(false);
  const shown = all ? data : data.slice(0, 6);
  const bmap = baseline ? new Map(baseline.map((i) => [i.label, i.count])) : null;
  const showChange = adopt ? true : showBaseline;
  return (
    <>
      <div className={`space-y-2 ${all && data.length > 10 ? "max-h-80 overflow-y-auto pr-1" : ""}`}>
        {shown.map((i, idx) => {
          const prev = bmap?.get(i.label);
          const cdel = adopt ? (adopt[i.label] ?? 0) : prev != null ? i.count - prev : null;
          const leader = idx === 0;
          const cls = `group/row -mx-2 flex items-center gap-3 rounded-lg px-2 py-1.5 transition hover:bg-cream/[0.04] ${drillParam ? "cursor-pointer" : ""}`;
          const RowTag = (drillParam ? Link : "div") as React.ElementType;
          const rowProps = drillParam ? { href: drillHref(drillParam, i.label, country, platform) } : {};
          return (
            <RowTag key={i.label} {...rowProps} className={cls} title={`${i.label}: ${i.count.toLocaleString()} (${i.pct}%)${adopt ? ` — +${adopt[i.label] ?? 0} launched ${adoptWord ?? "this period"}` : ""}${drillParam ? " — click to view stores" : ""}`}>
              <span className={`w-4 shrink-0 text-right text-xs tabular-nums ${leader ? toneText(tone) : "text-cream/30"}`}>{idx + 1}</span>
              <div className={`w-28 shrink-0 truncate text-sm ${leader ? "text-cream" : "text-cream/75"} ${drillParam ? "group-hover/row:text-cream" : ""}`}>{i.label}</div>
              <AnimatedFill pct={i.pct} tone={tone} />
              <div className="w-10 shrink-0 text-right text-sm font-medium tabular-nums text-cream">{i.pct}%</div>
              <div className="w-12 shrink-0 text-right text-xs tabular-nums text-cream/40">{i.count.toLocaleString()}</div>
              {showChange && <div className="w-14 shrink-0 text-right text-xs tabular-nums" title={adopt ? `launched ${adoptWord ?? "this period"}` : undefined}><CountDelta v={cdel} /></div>}
            </RowTag>
          );
        })}
      </div>
      {data.length > 6 && (
        <button onClick={() => setAll((a) => !a)} className="mt-4 text-sm font-medium text-cream/50 transition hover:text-cream">
          {all ? "Show top 6" : `See all ${data.length} →`}
        </button>
      )}
    </>
  );
}
