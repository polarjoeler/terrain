"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { marketLabel } from "@/lib/markets";
import { platformLabel } from "@/lib/platforms";
import { scoreColor } from "@/lib/revenue";
import { bandTone, REVENUE_BANDS, bandDisplay } from "@/lib/fx";
import type { BrowseResult, BrowseFilters, Facet as FacetData } from "@/lib/browse";
import { browse } from "./browse-action";
import { LeadDrawer } from "./lead-drawer";

const PAGE = 60;
// "new" surfaces freshly-discovered stores first (the primary driver) — see lib/browse.ts ORDER.
type SortKey = "new" | "score" | "sales" | "name";
// Platforms whose stores are self-hosted, so a hosting provider is a meaningful lead signal. The
// Hosting facet only makes sense for these — Shopify/Wix are SaaS (hosting is always the vendor).
const OPEN_SOURCE_PLATFORMS = ["woocommerce", "magento", "adobe_commerce", "prestashop", "ec-cube", "opencart"];

// Recency = how recently WE first tracked the store (discoveredAt), so "new this
// week/month/year" means newly-discovered leads. Windows are nested, so it's a
// single-select control, not multi-toggle.
type RecencyKey = "" | "7d" | "30d" | "365d";
const RECENCY_OPTS: { key: RecencyKey; label: string; days: number }[] = [
  { key: "7d", label: "New this week", days: 7 },
  { key: "30d", label: "New this month", days: 30 },
  { key: "365d", label: "New this year", days: 365 },
];
// Launch recency = when the store actually STARTED SELLING (launchedAt). This is
// the one people mean by "new stores"; discovery above is when we first saw it.
// Both exist because they answer different questions, and they are independent
// single-selects — nested windows, so not multi-toggle.
type LaunchKey = "" | "7d" | "30d" | "90d" | "365d";
const LAUNCH_OPTS: { key: LaunchKey; label: string; days: number }[] = [
  { key: "7d", label: "Launched this week", days: 7 },
  { key: "30d", label: "Launched this month", days: 30 },
  { key: "90d", label: "Launched this quarter", days: 90 },
  { key: "365d", label: "Launched this year", days: 365 },
];
// A real Shopify theme name is short and word-like (Dawn, Debut, Focal, Shrine PRO).
// The imported `theme` field is polluted with release notes / version strings for
// some stores ("[2.2.0]… oct release", "checkout (do not change)") — drop those.
const isCleanTheme = (t: string) => /^[A-Za-z][A-Za-z &'-]{1,24}$/.test(t.trim());

// WooCommerce activity tier — the "is this a REAL store or a stale build" reveal.
// Ordered strongest-first in the facet; labeled for humans in the rail.
const ACTIVITY_ORDER: Record<string, number> = { selling: 0, active: 1, dormant: 2, not_a_store: 3 };
const ACTIVITY_LABEL: Record<string, string> = {
  selling: "Selling (has sales/reviews)", active: "Active (live, stocked)",
  dormant: "Dormant (built, not selling)", not_a_store: "Not a store",
};

// Store logo. Favicons are built for LIGHT backgrounds, so on our dark table the
// dark/transparent ones muddy into the UI — we sit them on a white tile with a
// little padding so every logo reads cleanly. Google's service returns a generic
// globe (as a 200) for domains it doesn't know, which we can't detect, but its
// hard failures fall back to a colored monogram so we never show a broken image.
const MONO_TINTS = ["bg-mint/25 text-mint", "bg-lilac/25 text-lilac", "bg-orange/25 text-orange", "bg-cyan/25 text-cyan"];
function Logo({ domain, name }: { domain: string; name: string | null }) {
  const [failed, setFailed] = useState(false);
  const label = (name || domain).replace(/^www\./, "");
  const initial = (label.match(/[A-Za-z0-9]/)?.[0] ?? "•").toUpperCase();
  const tint = MONO_TINTS[[...domain].reduce((a, c) => a + c.charCodeAt(0), 0) % MONO_TINTS.length];
  if (failed) {
    return <div className={`grid h-6 w-6 shrink-0 place-items-center rounded text-[11px] font-bold ${tint}`}>{initial}</div>;
  }
  return (
    <img
      src={`https://www.google.com/s2/favicons?sz=64&domain=${domain}`}
      alt=""
      width={24}
      height={24}
      className="h-6 w-6 shrink-0 rounded bg-white object-contain p-0.5 ring-1 ring-black/5"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

function ScoreRing({ score }: { score: number }) {
  const c = scoreColor(score);
  const r = 13, circ = 2 * Math.PI * r;
  return (
    <div className="relative h-8 w-8">
      <svg viewBox="0 0 32 32" className="h-8 w-8 -rotate-90">
        <circle cx="16" cy="16" r={r} fill="none" stroke="var(--color-cream)" strokeOpacity="0.12" strokeWidth="3" />
        <circle cx="16" cy="16" r={r} fill="none" stroke={c} strokeWidth="3" strokeLinecap="round"
          strokeDasharray={circ} strokeDashoffset={circ * (1 - score / 100)} />
      </svg>
      <span className="absolute inset-0 grid place-items-center text-[11px] font-semibold tabular-nums" style={{ color: c }}>{score}</span>
    </div>
  );
}

function Facet({ title, values, selected, onToggle, label }: { title: string; values: [string, number][]; selected: Set<string>; onToggle: (v: string) => void; label?: (v: string) => string }) {
  const [open, setOpen] = useState(true);
  const [expand, setExpand] = useState(false);
  const shown = expand ? values : values.slice(0, 6);
  return (
    <div className="border-b border-cream/10 py-3">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wide text-cream/50">
        {title}<span className="text-cream/30">{open ? "–" : "+"}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-1">
          {shown.map(([v, n]) => (
            <button key={v} onClick={() => onToggle(v)}
              className={`flex w-full items-center justify-between rounded-lg px-2 py-1 text-left text-sm transition ${selected.has(v) ? "bg-cyan/15 text-cream" : "text-cream/70 hover:bg-cream/[0.05]"}`}>
              <span className="flex items-center gap-1.5 truncate">
                <span className={`h-3 w-3 shrink-0 rounded border ${selected.has(v) ? "border-cyan bg-cyan" : "border-cream/25"}`} />
                <span className="truncate">{label ? label(v) : title === "Country" ? marketLabel(v) : v}</span>
              </span>
              <span className="ml-2 shrink-0 text-xs tabular-nums text-cream/35">{n.toLocaleString()}</span>
            </button>
          ))}
          {values.length > 6 && (
            <button onClick={() => setExpand((e) => !e)} className="px-2 text-xs text-cream/45 hover:text-cream">
              {expand ? "Show less" : `+${values.length - 6} more`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Drill-through: insights data points link here with a facet pre-applied
// (e.g. /dashboard?payment=Paystack), and these seed the Explorer's filters.
export type ExploreInitial = {
  q?: string; country?: string[]; category?: string[]; band?: string[];
  theme?: string[]; city?: string[]; payment?: string[]; shipping?: string[];
  activity?: string[];    // seed Woo activity tier (selling/active/dormant) from a deep link
  recency?: RecencyKey;   // seed "newly discovered this week" (7d) etc. from a deep link
  launched?: LaunchKey;   // seed "launched this week" etc. from a deep link
  noPayment?: boolean;    // seed "no payment gateway detected yet" — prospect list
};

export function Explorer({ initialData, initial, showStats }: {
  initialData: BrowseResult; initial?: ExploreInitial;
  /** Render the live stat tiles above the table. The dashboard turns this on;
   *  /admin/explore leaves it off (it has its own header). */
  showStats?: boolean;
}) {
  const [q, setQ] = useState(initial?.q ?? "");
  // The search box updates `q` instantly (responsive input), but the heavy work — the full
  // filter+sort and all 11 facet counts, each a scan of every loaded row — keys off this DEBOUNCED
  // value, so it runs once ~220ms after typing stops instead of ~13× on every keystroke.
  const [qDebounced, setQDebounced] = useState(initial?.q ?? "");
  useEffect(() => { const t = setTimeout(() => setQDebounced(q), 220); return () => clearTimeout(t); }, [q]);
  const [country, setCountry] = useState<Set<string>>(new Set(initial?.country));
  const [category, setCategory] = useState<Set<string>>(new Set(initial?.category));
  const [band, setBand] = useState<Set<string>>(new Set(initial?.band));
  const [theme, setTheme] = useState<Set<string>>(new Set(initial?.theme));
  const [city, setCity] = useState<Set<string>>(new Set(initial?.city));
  const [payment, setPayment] = useState<Set<string>>(new Set(initial?.payment));
  const [shipping, setShipping] = useState<Set<string>>(new Set(initial?.shipping));
  const [app, setApp] = useState<Set<string>>(new Set());
  const [platform, setPlatform] = useState<Set<string>>(new Set());
  const [activity, setActivity] = useState<Set<string>>(new Set(initial?.activity)); // Woo: selling/active/dormant
  const [hosting, setHosting] = useState<Set<string>>(new Set());
  const [plusOnly, setPlusOnly] = useState(false);
  const [emailOnly, setEmailOnly] = useState(false);
  const [noPaymentOnly, setNoPaymentOnly] = useState(initial?.noPayment ?? false); // no gateway detected yet
  const [tier, setTier] = useState<"" | "top100" | "top500">(""); // curated Top 100 / Top 500
  const [recency, setRecency] = useState<RecencyKey>(initial?.recency ?? "");
  const [launched, setLaunched] = useState<LaunchKey>(initial?.launched ?? "");
  const [sort, setSort] = useState<SortKey>("new");
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<string | null>(null); // domain open in the detail drawer
  const [data, setData] = useState<BrowseResult>(initialData);
  const [loading, setLoading] = useState(false);

  const toggle = (set: React.Dispatch<React.SetStateAction<Set<string>>>) => (v: string) =>
    set((prev) => { const n = new Set(prev); n.has(v) ? n.delete(v) : n.add(v); return n; });

  // Server-driven: filtering, sorting, paging and all 11 facet counts run in SQL (lib/browse.ts via
  // the browse() action), so the client holds one ~60-row page + true counts over the whole table,
  // not ~13k rows re-scanned on every keystroke. The search box updates `q` instantly; the fetch keys
  // off the DEBOUNCED value so typing doesn't spam the server. Every other filter/sort/page change
  // refetches directly. Counts are now correct over the full dataset, not a top-by-revenue slice.
  const filters = useMemo<BrowseFilters>(() => ({
    q: qDebounced || undefined,
    country: country.size ? [...country] : undefined,
    platform: platform.size ? [...platform] : undefined,
    category: category.size ? [...category] : undefined,
    band: band.size ? [...band] : undefined,
    theme: theme.size ? [...theme] : undefined,
    city: city.size ? [...city] : undefined,
    payment: payment.size ? [...payment] : undefined,
    shipping: shipping.size ? [...shipping] : undefined,
    app: app.size ? [...app] : undefined,
    activity: activity.size ? [...activity] : undefined,
    hosting: hosting.size ? [...hosting] : undefined,
    plus: plusOnly || undefined,
    hasEmail: emailOnly || undefined,
    noPayment: noPaymentOnly || undefined,
    tier: tier || undefined,
    launchedDays: launched ? LAUNCH_OPTS.find((o) => o.key === launched)?.days : undefined,
    discoveredDays: recency ? RECENCY_OPTS.find((o) => o.key === recency)?.days : undefined,
    sort,
    limit,
  }), [qDebounced, country, platform, category, band, theme, city, payment, shipping, app, activity, hosting, plusOnly, emailOnly, noPaymentOnly, tier, launched, recency, sort, limit]);

  // initialData is SSR'd for the initial filters, so skip the very first run. A liveness guard keeps
  // an earlier slow reply from clobbering a newer one (facet toggles fire in quick succession).
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    let live = true;
    setLoading(true);
    browse(filters).then((res) => {
      if (!live) return;
      if (!("error" in res)) setData(res);
      setLoading(false);
    }).catch(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [filters]);

  const rows = data.rows;
  // Facet data (server `{value,count}[]`) → the `[value,count][]` shape the <Facet> rail renders.
  const fv = (f: FacetData): [string, number][] => f.map((x) => [x.value, x.count] as [string, number]);
  const bandOrder = new Map(REVENUE_BANDS.map((b, i) => [b as string, i]));
  const facets = {
    country: fv(data.facets.country),
    platform: fv(data.facets.platform),
    activity: fv(data.facets.activity).sort((a, b) => (ACTIVITY_ORDER[a[0]] ?? 9) - (ACTIVITY_ORDER[b[0]] ?? 9)),
    hosting: fv(data.facets.hosting),
    category: fv(data.facets.category),
    band: fv(data.facets.band).sort((a, b) => (bandOrder.get(a[0]) ?? 9) - (bandOrder.get(b[0]) ?? 9)),
    theme: fv(data.facets.theme).filter(([t]) => isCleanTheme(t)),
    city: fv(data.facets.city),
    payment: fv(data.facets.payment),
    shipping: fv(data.facets.shipping),
    apps: fv(data.facets.apps),
  };

  // Launch dates only populate once a snapshot carries them; hide the Launched control until then.
  const hasLaunchData = Object.values(data.recency.launched).some((n) => n > 0);
  const launchCount = (k: LaunchKey) => (k ? data.recency.launched[LAUNCH_OPTS.find((o) => o.key === k)!.days] ?? 0 : 0);
  const recencyCount = (k: RecencyKey) => (k ? data.recency.discovered[RECENCY_OPTS.find((o) => o.key === k)!.days] ?? 0 : 0);

  // Stat tiles read true counts over the WHOLE filtered set (from the aggregate), not the page.
  const liveStats = {
    shown: data.total,
    fresh: hasLaunchData ? (data.recency.launched[7] ?? 0) : (data.recency.discovered[7] ?? 0),
    plus: data.stats.plus,
    email: data.stats.email,
  };

  const clearAll = () => { setQ(""); setCountry(new Set()); setCategory(new Set()); setBand(new Set()); setTheme(new Set()); setCity(new Set()); setPayment(new Set()); setShipping(new Set()); setApp(new Set()); setPlatform(new Set()); setActivity(new Set()); setHosting(new Set()); setPlusOnly(false); setEmailOnly(false); setNoPaymentOnly(false); setTier(""); setRecency(""); setLaunched(""); setLimit(PAGE); };
  const activeCount = country.size + platform.size + activity.size + hosting.size + category.size + band.size + theme.size + city.size + payment.size + shipping.size + app.size + (plusOnly ? 1 : 0) + (emailOnly ? 1 : 0) + (noPaymentOnly ? 1 : 0) + (tier ? 1 : 0) + (recency ? 1 : 0) + (launched ? 1 : 0) + (q ? 1 : 0);

  // Export the FULL filtered set from the server (every matching row + full field set), not just the
  // page on screen — this also closes the old unmetered client-side export. POST the active filters.
  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    setExporting(true);
    try {
      const res = await fetch("/api/explore-export", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(filters),
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `terrain-leads-${data.total}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } finally { setExporting(false); }
  };

  // Platform-aware filter visibility: Shopify-only controls (Plus, the Shopify app-store facet) show
  // only when Shopify is in the filter; Hosting shows only for self-hosted platforms, since for SaaS
  // platforms (Shopify/Wix) the host is always the vendor and tells you nothing.
  const shopifySelected = platform.has("shopify");
  const openSourceSelected = [...platform].some((p) => OPEN_SOURCE_PLATFORMS.includes(p));

  return (
    <div className="flex min-h-screen gap-0">
      {/* filter rail */}
      <aside className="w-64 shrink-0 border-r border-cream/10 px-4 py-5">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-cream">Filters {activeCount > 0 && <span className="ml-1 rounded-full bg-cyan/20 px-1.5 text-xs text-cyan">{activeCount}</span>}</span>
          {activeCount > 0 && <button onClick={clearAll} className="text-xs text-cream/45 hover:text-cream">Clear all</button>}
        </div>
        {/* Country + CMS are the primary filters — they lead the rail. */}
        <Facet title="Country" values={facets.country} selected={country} onToggle={toggle(setCountry)} />
        {(facets.platform.length > 1 || platform.size > 0) && <Facet title="CMS / platform" values={facets.platform} selected={platform} onToggle={toggle(setPlatform)} label={platformLabel} />}

        {/* Quick toggles. Shopify-specific controls appear only when Shopify is in the platform filter. */}
        <div className="mt-3 space-y-1">
          {shopifySelected && (
            <button onClick={() => setPlusOnly((p) => !p)} className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${plusOnly ? "bg-lilac/20 text-cream" : "text-cream/70 hover:bg-cream/[0.05]"}`}>
              <span className={`h-3 w-3 rounded border ${plusOnly ? "border-lilac bg-lilac" : "border-cream/25"}`} /> Shopify Plus only
            </button>
          )}
          <button onClick={() => setEmailOnly((p) => !p)} className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${emailOnly ? "bg-mint/20 text-cream" : "text-cream/70 hover:bg-cream/[0.05]"}`}>
            <span className={`h-3 w-3 rounded border ${emailOnly ? "border-mint bg-mint" : "border-cream/25"}`} /> Has email
          </button>
          <button onClick={() => setNoPaymentOnly((p) => !p)} className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${noPaymentOnly ? "bg-orange/20 text-cream" : "text-cream/70 hover:bg-cream/[0.05]"}`}>
            <span className={`h-3 w-3 rounded border ${noPaymentOnly ? "border-orange bg-orange" : "border-cream/25"}`} /> Checked · no gateway yet
          </button>
          {/* Curated Top 100 / Top 500 — mutually exclusive (Top 100 is the elite subset). */}
          <div className="flex gap-1 pt-1">
            <button onClick={() => setTier((t) => (t === "top100" ? "" : "top100"))}
              className={`flex-1 rounded-lg px-2 py-1.5 text-sm transition ${tier === "top100" ? "bg-cyan/20 font-medium text-cream" : "text-cream/70 hover:bg-cream/[0.05]"}`}>Top 100</button>
            <button onClick={() => setTier((t) => (t === "top500" ? "" : "top500"))}
              className={`flex-1 rounded-lg px-2 py-1.5 text-sm transition ${tier === "top500" ? "bg-cyan/20 font-medium text-cream" : "text-cream/70 hover:bg-cream/[0.05]"}`}>Top 500</button>
          </div>
        </div>

        {/* Newly discovered — when WE first saw it. The key control for new stores. Single-select. */}
        <div className="mt-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-cream/50">Newly discovered</div>
          <div className="mt-2 space-y-1">
            {RECENCY_OPTS.map((o) => {
              const on = recency === o.key;
              return (
                <button key={o.key} onClick={() => { setRecency(on ? "" : o.key); setLimit(PAGE); }}
                  className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-sm ${on ? "bg-cyan/20 text-cream" : "text-cream/70 hover:bg-cream/[0.05]"}`}>
                  <span className="flex items-center gap-2">
                    <span className={`h-3 w-3 rounded-full border ${on ? "border-cyan bg-cyan" : "border-cream/25"}`} />
                    {o.label}
                  </span>
                  <span className="text-xs text-cream/40">{recencyCount(o.key).toLocaleString()}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Launched — when the store started selling. Single-select (nested windows). */}
        {hasLaunchData && (
          <div className="mt-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-cream/50">Launched</div>
            <div className="mt-2 space-y-1">
              {LAUNCH_OPTS.map((o) => {
                const on = launched === o.key;
                return (
                  <button key={o.key} onClick={() => { setLaunched(on ? "" : o.key); setLimit(PAGE); }}
                    className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-sm ${on ? "bg-orange/20 text-cream" : "text-cream/70 hover:bg-cream/[0.05]"}`}>
                    <span className="flex items-center gap-2">
                      <span className={`h-3 w-3 rounded-full border ${on ? "border-orange bg-orange" : "border-cream/25"}`} />
                      {o.label}
                    </span>
                    <span className="text-xs tabular-nums text-cream/40">{launchCount(o.key).toLocaleString()}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Secondary facets. Woo activity shows only when there's Woo data; Hosting only for self-hosted
            platforms; the Shopify app-store facet only when Shopify is selected. */}
        {facets.activity.length > 0 && <Facet title="Woo activity" values={facets.activity} selected={activity} onToggle={toggle(setActivity)} label={(v) => ACTIVITY_LABEL[v] ?? v} />}
        {openSourceSelected && facets.hosting.length > 1 && <Facet title="Hosting" values={facets.hosting} selected={hosting} onToggle={toggle(setHosting)} />}
        <Facet title="Revenue" values={facets.band} selected={band} onToggle={toggle(setBand)} />
        <Facet title="Category" values={facets.category} selected={category} onToggle={toggle(setCategory)} />
        <Facet title="Theme" values={facets.theme} selected={theme} onToggle={toggle(setTheme)} />
        <Facet title="Payment" values={facets.payment} selected={payment} onToggle={toggle(setPayment)} />
        <Facet title="Shipping" values={facets.shipping} selected={shipping} onToggle={toggle(setShipping)} />
        {shopifySelected && <Facet title="Apps" values={facets.apps} selected={app} onToggle={toggle(setApp)} />}
        <Facet title="City" values={facets.city} selected={city} onToggle={toggle(setCity)} />
      </aside>

      {/* main */}
      <main className="min-w-0 flex-1 px-5 py-5">
        {showStats && (
          <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="rounded-3xl bg-mint p-5 text-ink">
              <div className="font-display text-4xl tabular-nums">+{liveStats.fresh.toLocaleString()}</div>
              <div className="mt-1 text-xs font-semibold uppercase tracking-wide opacity-70">{hasLaunchData ? "Launched" : "Newly discovered"} · 7d</div>
            </div>
            <div className="rounded-3xl bg-lilac p-5 text-ink">
              <div className="font-display text-4xl tabular-nums">{liveStats.plus.toLocaleString()}</div>
              <div className="mt-1 text-xs font-semibold uppercase tracking-wide opacity-70">Shopify Plus</div>
            </div>
            <div className="rounded-3xl border border-cream/15 p-5">
              <div className="font-display text-4xl tabular-nums">{liveStats.email.toLocaleString()}</div>
              <div className="mt-1 text-xs font-semibold uppercase tracking-wide text-cream/50">With direct email</div>
            </div>
            <div className="rounded-3xl border border-cream/15 p-5">
              <div className="font-display text-4xl tabular-nums">{liveStats.shown.toLocaleString()}</div>
              <div className="mt-1 text-xs font-semibold uppercase tracking-wide text-cream/50">
                {activeCount > 0 ? "Stores matching" : "Stores tracked"}
              </div>
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <input value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} placeholder="Search domain or store…"
            className="w-72 rounded-full border border-cream/15 bg-transparent px-4 py-2 text-sm text-cream outline-none placeholder:text-cream/35 focus:border-cream/50" />
          <select value={sort} onChange={(e) => { setSort(e.target.value as SortKey); setLimit(PAGE); }} className="rounded-full border border-cream/15 bg-transparent px-3 py-2 text-sm text-cream outline-none">
            <option value="new" className="text-ink">Sort: Newest first</option>
            <option value="score" className="text-ink">Sort: Lead Fit Score</option>
            <option value="sales" className="text-ink">Sort: Revenue</option>
            <option value="name" className="text-ink">Sort: Name</option>
          </select>
          <span className="text-sm text-cream/50">
            <b className="text-cream">{data.total.toLocaleString()}</b> of {data.universe.toLocaleString()} leads
            {loading && <span className="ml-1 text-cream/35">· updating…</span>}
          </span>
          <button onClick={exportCsv} disabled={exporting} className="ml-auto rounded-full bg-mint px-4 py-2 text-sm font-medium text-ink transition hover:brightness-105 disabled:opacity-60">
            {exporting ? "Exporting…" : `Export ${data.total.toLocaleString()} → CSV`}
          </button>
        </div>

        <div className={`mt-4 overflow-x-auto rounded-2xl border border-cream/10 transition-opacity ${loading ? "opacity-60" : ""}`}>
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="border-b border-cream/10 text-xs uppercase tracking-wide text-cream/40">
              <tr>
                <th className="px-4 py-3">Store</th><th className="px-4 py-3">Category</th><th className="px-4 py-3">Market</th>
                <th className="px-4 py-3">Revenue</th><th className="px-4 py-3">Catalog</th><th className="px-4 py-3">Fit</th><th className="px-4 py-3">Contacts</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => {
                const b = l.band;
                const bd = bandDisplay(l.band, l.country);
                return (
                  <tr key={l.domain} onClick={() => setSelected(l.domain)} className="cursor-pointer border-t border-cream/[0.07] transition hover:bg-cream/[0.05]" title="View all known data">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <div className="shrink-0"><Logo domain={l.domain} name={l.name} /></div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 font-medium text-cream">
                            <span className="truncate">{l.name ?? l.domain}</span>
                            {l.plus && <span className="rounded bg-lilac/20 px-1 py-0.5 text-[8px] font-bold text-lilac">PLUS</span>}
                            {l.platform === "woocommerce" && <span className="rounded bg-cream/10 px-1 py-0.5 text-[8px] font-bold uppercase text-cream/50">Woo</span>}
                            {l.activityTier && l.activityTier !== "not_a_store" && (
                              <span className={`rounded px-1 py-0.5 text-[8px] font-bold uppercase ${l.activityTier === "selling" ? "bg-mint/20 text-mint" : l.activityTier === "active" ? "bg-cyan/20 text-cyan" : "bg-orange/20 text-orange"}`}>{l.activityTier}</span>
                            )}
                          </div>
                          {/* External site link — stop the row's drawer-open when clicked. */}
                          <a href={`https://${l.domain}`} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="font-mono text-xs text-cream/40 hover:underline">{l.domain}</a>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-cream/60">{l.category ?? "—"}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-cream/70">{l.country ? marketLabel(l.country) : "—"}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${bandTone(b)}`}>{bd.local}</span>
                      <span className="ml-1 text-xs text-cream/30">{bd.usd}</span>
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-xs text-cream/50">
                      {l.productCount != null ? `${l.productCount >= 250 ? "250+" : l.productCount} products` : <span className="text-cream/25">—</span>}
                      {l.aovUsd != null && <span className="text-cream/30"> · ${Math.round(l.aovUsd)} AOV</span>}
                    </td>
                    <td className="px-4 py-2.5"><ScoreRing score={l.score} /></td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2 text-xs" onClick={(e) => e.stopPropagation()}>
                        {l.email ? <a href={`mailto:${l.email}`} className="text-cyan hover:underline">✉ {l.email.length > 22 ? l.email.slice(0, 22) + "…" : l.email}</a> : <span className="text-cream/25">no email</span>}
                        {l.instagram && <a href={`https://instagram.com/${l.instagram.replace(/^@/, "")}`} target="_blank" rel="noopener noreferrer" className="text-cream/40 hover:text-cream">IG</a>}
                        {l.facebook && <span className="text-cream/40">FB</span>}
                        {l.tiktok && <span className="text-cream/40">TT</span>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {rows.length < data.total && (
          <div className="mt-4 text-center">
            <button onClick={() => setLimit((s) => s + PAGE)} disabled={loading} className="rounded-full border border-cream/15 px-5 py-2 text-sm text-cream/70 hover:border-cream/40 disabled:opacity-50">
              {loading ? "Loading…" : `Load more (${(data.total - rows.length).toLocaleString()} left)`}
            </button>
          </div>
        )}
      </main>

      <LeadDrawer domain={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
