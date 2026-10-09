"use client";

import { createContext, useContext, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { classify, PAY_TYPES, type PayType } from "@/lib/payments-taxonomy";
import type { ProviderMomentum, PaymentShift } from "@/lib/provider-insights";
import { marketLabel, marketAdjective } from "@/lib/markets";
import { tagLabel } from "@/lib/tag-defs";
import type { InsightsData, InsightItem, PlatformSel } from "@/lib/insights";

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

const PERIODS = ["Day", "Week", "Month", "Quarter", "Year"] as const;
type Period = (typeof PERIODS)[number];
const PERIOD_DAYS: Record<Period, number> = { Day: 1, Week: 7, Month: 30, Quarter: 91, Year: 365 };
const PERIOD_KEY: Record<Period, "day" | "week" | "month" | "quarter" | "year"> =
  { Day: "day", Week: "week", Month: "month", Quarter: "quarter", Year: "year" };
const COMPARISON: Record<Period, string> = { Day: "DoD", Week: "WoW", Month: "MoM", Quarter: "QoQ", Year: "YoY" };
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
    const q = new URLSearchParams();
    if (country) q.set("country", country);
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
  data, provByType, baseProvByType, base, tfTouched, pk, pw, country, subtitle,
}: {
  data: InsightsData;
  provByType: Record<PayType, InsightItem[]>;
  baseProvByType: Record<PayType, InsightItem[]> | null;
  base: InsightsData | null;
  tfTouched: boolean;
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
      subtitle={subtitle ?? `Checkout-verified on ${data.coverage.paymentPct}% of reachable stores (${data.paymentsVerifiedStores.toLocaleString()} of ${data.coverage.paymentReachable.toLocaleString()}) — the rest have no completable checkout to read`}
      reportHref={`/insights/payments?country=${country}${pfx}`}
    >
      {/* Headline signals for payment-company subscribers */}
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
      <div className="space-y-7">
        {PAY_TYPES.map((t) =>
          provByType[t].length ? (
            <div key={t}>
              <div className="mb-3 flex flex-wrap items-baseline gap-x-2">
                <span className="text-xs font-bold uppercase tracking-wide text-cream/80">{t}</span>
                <span className="text-[11px] text-cream/40">
                  {TYPE_LABEL[t]} · {data.paymentsByType[t].pct}% of stores ({data.paymentsByType[t].count.toLocaleString()})
                </span>
              </div>
              <DrillList data={provByType[t]} baseline={baseProvByType?.[t] ?? null} tone={TYPE_TONE[t]} showBaseline={!!base} drillParam="payment" country={country} adopt={tfTouched ? data.launchedDistro[pk].payments : undefined} adoptWord={pw} />
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
  const [period, setPeriod] = useState<Period>("Month");
  // Report-wide custom date range. Drives the growth chart (real launch/churn over the range);
  // the preset periods above still drive the tiles + distribution comparisons.
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const [preset, setPreset] = useState("");   // active time-period preset ("" = all time / custom)
  const rangeActive = !!(rangeFrom || rangeTo);
  const applyPreset = (key: string) => {
    const { from, to } = presetRange(key);
    setPreset(key); setRangeFrom(from); setRangeTo(to); setTfTouched(true);
  };
  const fmtDay = (d: string) => (d ? new Date(d + "T00:00:00Z").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "");
  // The payment "+N adoptions" column only shows once the user has ACTIVELY engaged the timeframe
  // (picked a period or set a custom range) — not on the default load, where a bare "+N" is noise.
  const [tfTouched, setTfTouched] = useState(false);

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
  const base = hasComparison(period) ? baselineFor(period) : null;
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
  const provByType = groupByType(data.paymentsByProvider);
  const baseProvByType = base ? groupByType(base.paymentsByProvider) : null;

  // Store survival "going forward" — measured against the earliest snapshot
  // (the baseline), so the one-time import's dead/migrated stores don't count;
  // we only show what churns from that point on.
  const baseline = effHistory.length >= 2 ? effHistory[0] : null;
  const fwdMigrated = baseline ? Math.max(0, data.churn.migrated - baseline.churn.migrated) : 0;
  const fwdDead = baseline ? Math.max(0, data.churn.dead - baseline.churn.dead) : 0;
  const trackedBase = data.churn.active + fwdMigrated + fwdDead;
  const fwdSurvival = trackedBase > 0 ? Math.round((100 * data.churn.active) / trackedBase) : null;

  const pk = PERIOD_KEY[period];
  const pw = PERIOD_WORD[period];
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
                className="rounded-full border border-cream/15 bg-transparent px-4 py-1.5 text-sm text-cream outline-none focus:border-cream/50"
              >
                {countries.map((c) => (
                  <option key={c.country} value={c.country} className="text-ink">
                    {marketLabel(c.country)} ({c.stores.toLocaleString()})
                  </option>
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
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-cream/40">Platform</span>
            {/* Data-driven: "All" + every CMS with a live presence in this market (availablePlatforms).
                Shopify always leads; the long tail (Wix, BASE, cafe24, …) appears where it exists. */}
            {[{ platform: "all", live: 0 }, ...platforms].map(({ platform: key, live }) => (
              <button key={key} onClick={() => go({ platform: key })}
                title={key === "all" ? "Every CMS combined" : `${live.toLocaleString()} live ${platformLabel(key)} stores in ${marketLabel(country)}`}
                className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm transition ${platform === key ? "bg-cream text-ink" : "border border-cream/15 text-cream/60 hover:text-cream"}`}>
                <span className="h-2 w-2 rounded-full" style={{ background: platformDot(key) }} /> {platformLabel(key)}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-cream/40">Timeframe</span>
            {PERIODS.map((p) => {
              const cmp = hasComparison(p);
              return (
                <button
                  key={p}
                  onClick={() => { setPeriod(p); setTfTouched(true); }}
                  title={cmp ? `Stores launched in the last ${PERIOD_DAYS[p]} days · compares vs ${PERIOD_DAYS[p]} days ago` : `Stores launched in the last ${PERIOD_DAYS[p]} days`}
                  className={`rounded-full px-3.5 py-1.5 text-sm transition ${
                    period === p
                      ? "bg-orange text-cream"
                      : "border border-cream/15 text-cream/60 hover:border-cream/40"
                  }`}
                >
                  {p}
                </button>
              );
            })}
            <span className="ml-1 text-xs text-cream/40">
              {tfTouched
                ? base ? `launched ${PERIOD_WORD[period]} · vs ${PERIOD_PREV[period]} (${COMPARISON[period]})` : `showing what launched ${PERIOD_WORD[period]}`
                : "pick a timeframe to see what launched then"}
            </span>
          </div>
          {/* Report-wide custom date range — applies to the growth chart (real launch/churn
              over any window). A visible separator so it reads as its own control. */}
          <div className="flex flex-wrap items-center gap-2 border-l border-cream/10 pl-6">
            <span className="text-xs font-semibold uppercase tracking-wide text-cream/40">Period</span>
            {/* Preset dropdown: relative windows + calendar periods (this/last month & quarter, Q1–Q4,
                YTD). Resolves to an absolute range that drives the growth chart. */}
            <select value={preset} onChange={(e) => applyPreset(e.target.value)}
              className="rounded-full border border-cream/15 bg-transparent px-3 py-1.5 text-sm text-cream outline-none focus:border-cream/50 [&>optgroup]:bg-ink-deep [&>option]:bg-ink-deep">
              {["", "Recent", "Calendar", "Quarters"].map((grp) => {
                const opts = DATE_PRESETS.filter((p) => p.group === grp);
                return grp === "" ? opts.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)
                  : <optgroup key={grp} label={grp}>{opts.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</optgroup>;
              })}
            </select>
            <span className="text-cream/30">·</span>
            <input type="date" value={rangeFrom} onChange={(e) => { setRangeFrom(e.target.value); setPreset(""); setTfTouched(true); }}
              className="rounded-full border border-cream/15 bg-transparent px-3 py-1.5 text-sm text-cream outline-none focus:border-cream/50" />
            <span className="text-cream/30">→</span>
            <input type="date" value={rangeTo} onChange={(e) => { setRangeTo(e.target.value); setPreset(""); setTfTouched(true); }}
              className="rounded-full border border-cream/15 bg-transparent px-3 py-1.5 text-sm text-cream outline-none focus:border-cream/50" />
            {rangeActive && (
              <button onClick={() => { setRangeFrom(""); setRangeTo(""); setPreset(""); }}
                className="text-xs text-cream/40 hover:text-cream">clear</button>
            )}
          </div>
        </div>
        {rangeActive && (
          <div className="mt-2 text-xs text-cream/45">
            Showing <b className="text-cream/70">{fmtDay(rangeFrom) || "start"} → {fmtDay(rangeTo) || "today"}</b>
            {" "}· as of {fmtDay(data.date)}
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

        <div className="mt-8 grid gap-5 md:grid-cols-2">
          {/* New launches vs churn per period (diverging bars). On the combined "all" view this is
              all-ecommerce; the cumulative Shopify-vs-Woo trajectory sits beside it below. */}
          <GrowthChart country={country} platform={platform} period={PERIOD_KEY[period]} from={rangeFrom} to={rangeTo} title={`${country ? marketLabel(country) + " " : ""}${platform === "all" ? "all-ecommerce" : platformLabel(platform)} launches & churn`.replace(/\s+/g, " ")} />

          {/* Combined view only: cumulative growth split by platform, so you can see whether Woo or
              Shopify is growing faster (hover a legend chip for its selling/active/dormant split). */}
          {platform === "all" && <PlatformGrowthChart country={country} />}

          {/* WooCommerce now has real checkout-verified payment data — show the SAME PSP/BNPL/APM
              breakdown as Shopify (its own Woo sections still follow below). */}
          {platform === "woocommerce" && (
            <PaymentIntelligenceCard data={data} provByType={provByType} baseProvByType={baseProvByType} base={base} tfTouched={tfTouched} pk={pk} pw={pw} country={country} />
          )}

          {/* Shopify payment intelligence — hidden on the WooCommerce view (its own sections below) */}
          {platform !== "woocommerce" && (<>
          {/* Payment providers — broken out by PSP / BNPL / APM, each drillable */}
          <PaymentIntelligenceCard data={data} provByType={provByType} baseProvByType={baseProvByType} base={base} tfTouched={tfTouched} pk={pk} pw={pw} country={country} />

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
              <DrillList data={data.firstProvider} baseline={base?.firstProvider ?? null} tone="orange" showBaseline={!!base} drillParam="payment" country={country} adopt={tfTouched ? data.launchedDistro[pk].leading : undefined} adoptWord={pw} />
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
          <DistroCard title="Categories" subtitle={`Of ${data.categoriesKnown.toLocaleString()} categorised stores`} data={data.categories} baseline={base?.categories ?? null} tone="cyan" drillParam="category" country={country} reportHref={`/insights/categories?country=${country}${pfx}`} adopt={tfTouched ? data.launchedDistro[pk].categories : undefined} adoptWord={pw} />
          {/* Themes + apps are SHOPIFY-specific (Shopify has no cross-platform equivalent), so they
              only appear when the Shopify platform is selected — not on the combined "all" view. */}
          {platform === "shopify" && (<>
          <DistroCard title="Theme market share" subtitle={`Of ${data.themesKnown.toLocaleString()} stores with a known theme`} data={data.themes} baseline={base?.themes ?? null} tone="mint" drillParam="theme" country={country} reportHref={`/insights/themes?country=${country}${pfx}`} adopt={tfTouched ? data.launchedDistro[pk].themes : undefined} adoptWord={pw} />
          <DistroCard title="Top apps installed" subtitle={`Of ${data.appsKnown.toLocaleString()} stores with app data`} data={data.apps} baseline={base?.apps ?? null} tone="lilac" reportHref={`/insights/apps?country=${country}${pfx}`} adopt={tfTouched ? data.launchedDistro[pk].apps : undefined} adoptWord={pw} />
          </>)}
          <DistroCard title="Cities" subtitle={`Of ${data.citiesKnown.toLocaleString()} stores with a location`} data={data.cities} baseline={base?.cities ?? null} tone="orange" drillParam="city" country={country} reportHref={`/insights/cities?country=${country}${pfx}`} adopt={tfTouched ? data.launchedDistro[pk].cities : undefined} adoptWord={pw} />
          <DistroCard
            title="Shipping providers"
            subtitle={`Checkout-verified on ${data.shippingKnown.toLocaleString()} stores · ${data.shippingKnown ? Math.round((100 * data.freeShippingStores) / data.shippingKnown) : 0}% offer free shipping`}
            data={data.shippingByProvider}
            baseline={base?.shippingByProvider ?? null}
            tone="cyan"
            drillParam="shipping"
            country={country}
            reportHref={`/insights/shipping?country=${country}${pfx}`}
            adopt={tfTouched ? data.launchedDistro[pk].shipping : undefined}
            adoptWord={pw}
          />
          </>)}
        </div>

        {/* Store survival & churn — measured GOING FORWARD from our baseline, so
            the one-time bulk import's already-dead/migrated stores don't skew it. */}
        <section className="mt-10">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-cream/50">Store survival &amp; churn</h2>
            <span className="text-xs text-cream/35">
              {baseline ? `tracked since ${baseline.date}` : "tracking from today — forward churn accrues daily"}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[
              { n: fwdSurvival != null ? `${fwdSurvival}%` : "—", label: "still live", tone: "mint" },
              { n: data.churn.active.toLocaleString(), label: "actively tracked", tone: "outline" },
              { n: fwdMigrated.toLocaleString(), label: "migrated off · since baseline", tone: "outline" },
              { n: fwdDead.toLocaleString(), label: "closed · since baseline", tone: "outline" },
            ].map((c) => (
              <div key={c.label} className={`rounded-3xl px-5 py-6 ${c.tone === "mint" ? "bg-mint text-ink" : "border border-cream/12 text-cream"}`}>
                <div className="font-display text-4xl leading-none tracking-tight md:text-5xl">{c.n}</div>
                <div className={`mt-2 text-xs font-medium uppercase tracking-wide ${c.tone === "mint" ? "opacity-70" : "text-cream/45"}`}>{c.label}</div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-cream/40">
            Forward-looking: we only count stores that migrate off Shopify or close <em>after</em> we
            started tracking them — the one-time bulk import is excluded so this reflects real ongoing churn.
          </p>

          {/* Where the migrating stores went — the platform-switch intel. */}
          {(data.churn.migratedTo?.length ?? 0) > 0 && (
            <div className="mt-4 rounded-3xl border border-cream/12 px-5 py-4">
              <div className="mb-2 flex items-baseline justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-cream/50">Migrated to</h3>
                <span className="text-xs text-cream/35">
                  {data.churn.migratedTo!.reduce((s, m) => s + m.n, 0).toLocaleString()} stores now on another platform
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {data.churn.migratedTo!.map((m) => (
                  <span key={m.platform} className="flex items-center gap-1.5 rounded-full border border-cream/12 px-3 py-1 text-xs text-cream/80">
                    <span className="font-medium text-cream">{m.platform}</span>
                    <span className="text-cream/40 tabular-nums">{m.n.toLocaleString()}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </section>

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
