"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { saveListAction } from "@/app/(app)/lists/actions";
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

// Merge theme rows that are the same name apart from case/whitespace ("Dawn" + "dawn" + "Dawn ")
// into one row: summed count, best-cased label. The browse filter already matches theme
// case/whitespace-insensitively (btrim + ILIKE), so the merged label still selects every variant —
// this is display-only.
function mergeThemes(values: [string, number][]): [string, number][] {
  const label = new Map<string, string>();
  const best = new Map<string, number>();
  const total = new Map<string, number>();
  for (const [v, n] of values) {
    if (!isCleanTheme(v)) continue;
    const name = v.trim().replace(/\s+/g, " ");
    const key = name.toLowerCase();
    total.set(key, (total.get(key) ?? 0) + n);
    if (!best.has(key) || n > best.get(key)!) { best.set(key, n); label.set(key, name); }
  }
  return [...total.entries()].map(([k, n]) => [label.get(k)!, n] as [string, number]).sort((a, b) => b[1] - a[1]);
}

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

// Contact-quality facet: best contact first, so the rail reads as a quality ladder.
const CONTACT_LABEL: Record<string, string> = {
  named: "Named person", role_targeted: "Decision-maker role", role_generic: "Generic inbox",
  form_only: "Form only", none: "No contact found",
};
const CONTACT_ORDER: Record<string, number> = { named: 0, role_targeted: 1, role_generic: 2, form_only: 3, none: 4 };

function Facet({ title, values, selected, onToggle, label, defaultOpen = true }: { title: string; values: [string, number][]; selected: Set<string>; onToggle: (v: string) => void; label?: (v: string) => string; defaultOpen?: boolean }) {
  // Collapsed by default for secondary facets to keep the rail compact — but auto-open if it already
  // holds a selection, so active filters are never hidden.
  const [open, setOpen] = useState(selected.size > 0 ? true : defaultOpen);
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

// Collapsible wrapper for the non-facet filter groups (Newly discovered, Launched) so every
// filter section in the rail collapses, not just the facets.
function Section({ title, children, defaultOpen = true }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mt-4 border-b border-cream/10 pb-3">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wide text-cream/50">
        {title}<span className="text-cream/30">{open ? "–" : "+"}</span>
      </button>
      {open && <div className="mt-2 space-y-1">{children}</div>}
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
  // The rest let a Saved list restore the whole view (not just a single-facet deep link).
  platform?: string[]; apps?: string[]; plugins?: string[]; tech?: string[]; hosting?: string[];
  plus?: boolean; email?: boolean; tier?: string; sort?: string;
  reachable?: boolean; contactType?: string[];   // contact-quality view, restorable by a Saved list
  // Terminal-state deep links (Overview "Migrations" / "Went dark" chips) — SSR-only, no UI control.
  status?: "migrated" | "dead"; checkedDays?: number;
};

export type ExportUsage = {
  used: number;
  /** null = unmetered (Intelligence, Partner) — we count, we don't refuse. */
  limit: number | null;
  remaining: number | null;
  planLabel: string;
};

export function Explorer({ initialData, initial, showStats, usage: usageProp }: {
  initialData: BrowseResult; initial?: ExploreInitial;
  /** Render the live stat tiles above the table. The dashboard turns this on;
   *  /admin/explore leaves it off (it has its own header). */
  showStats?: boolean;
  /** This seat's export allowance, resolved server-side. Omitted for admins, who
   *  export unmetered. */
  usage?: ExportUsage;
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
  const [app, setApp] = useState<Set<string>>(new Set(initial?.apps));
  const [plugin, setPlugin] = useState<Set<string>>(new Set(initial?.plugins));
  const [tech, setTech] = useState<Set<string>>(new Set(initial?.tech));   // cross-platform vendor fingerprints (technologies)
  const [platform, setPlatform] = useState<Set<string>>(new Set(initial?.platform));
  const [activity, setActivity] = useState<Set<string>>(new Set(initial?.activity)); // Woo: selling/active/dormant
  const [hosting, setHosting] = useState<Set<string>>(new Set(initial?.hosting));
  const [plusOnly, setPlusOnly] = useState(initial?.plus ?? false);
  const [emailOnly, setEmailOnly] = useState(initial?.email ?? false);
  // "Reaches a person" — a named address or a decision-maker's role mailbox. The filter the
  // generic-mailbox complaint is really asking for.
  const [reachableOnly, setReachableOnly] = useState(initial?.reachable ?? false);
  const [contactType, setContactType] = useState<Set<string>>(new Set(initial?.contactType));
  const [noPaymentOnly, setNoPaymentOnly] = useState(initial?.noPayment ?? false); // no gateway detected yet
  const [tier, setTier] = useState<"" | "top100" | "top500">((initial?.tier as "" | "top100" | "top500") ?? ""); // curated Top 100 / Top 500
  const [recency, setRecency] = useState<RecencyKey>(initial?.recency ?? "");
  const [launched, setLaunched] = useState<LaunchKey>(initial?.launched ?? "");
  const [sort, setSort] = useState<SortKey>((initial?.sort as SortKey) ?? "new");
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<string | null>(null); // domain open in the detail drawer
  const [picked, setPicked] = useState<Set<string>>(new Set());   // ticked rows for selective export
  const togglePick = (domain: string) => setPicked((prev) => { const n = new Set(prev); n.has(domain) ? n.delete(domain) : n.add(domain); return n; });
  const [data, setData] = useState<BrowseResult>(initialData);
  const [loading, setLoading] = useState(false);
  // Export allowance, kept live: every export response carries the new figure, so the
  // customer sees what a download cost without a reload.
  const [usage, setUsage] = useState<ExportUsage | undefined>(usageProp);
  const [exportMsg, setExportMsg] = useState("");

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
    plugin: plugin.size ? [...plugin] : undefined,
    tech: tech.size ? [...tech] : undefined,
    activity: activity.size ? [...activity] : undefined,
    hosting: hosting.size ? [...hosting] : undefined,
    plus: plusOnly || undefined,
    hasEmail: emailOnly || undefined,
    reachableContact: reachableOnly || undefined,
    contactType: contactType.size ? [...contactType] : undefined,
    noPayment: noPaymentOnly || undefined,
    tier: tier || undefined,
    launchedDays: launched ? LAUNCH_OPTS.find((o) => o.key === launched)?.days : undefined,
    discoveredDays: recency ? RECENCY_OPTS.find((o) => o.key === recency)?.days : undefined,
    sort,
    limit,
  }), [qDebounced, country, platform, category, band, theme, city, payment, shipping, app, plugin, tech, activity, hosting, plusOnly, emailOnly, reachableOnly, contactType, noPaymentOnly, tier, launched, recency, sort, limit]);

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
    theme: mergeThemes(fv(data.facets.theme)),
    city: fv(data.facets.city),
    payment: fv(data.facets.payment),
    shipping: fv(data.facets.shipping),
    apps: fv(data.facets.apps),
    plugins: fv(data.facets.plugins),
    tech: fv(data.facets.tech),
    contactType: fv(data.facets.contactType).sort((a, b) => (CONTACT_ORDER[a[0]] ?? 9) - (CONTACT_ORDER[b[0]] ?? 9)),
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
    reachable: data.stats.reachable,
    willBounce: data.stats.willBounce,
  };

  const clearAll = () => { setQ(""); setCountry(new Set()); setCategory(new Set()); setBand(new Set()); setTheme(new Set()); setCity(new Set()); setPayment(new Set()); setShipping(new Set()); setApp(new Set()); setPlatform(new Set()); setActivity(new Set()); setHosting(new Set()); setPlusOnly(false); setEmailOnly(false); setReachableOnly(false); setContactType(new Set()); setNoPaymentOnly(false); setTier(""); setRecency(""); setLaunched(""); setLimit(PAGE); };
  const activeCount = country.size + platform.size + activity.size + hosting.size + category.size + band.size + theme.size + city.size + payment.size + shipping.size + app.size + (plusOnly ? 1 : 0) + (emailOnly ? 1 : 0) + (reachableOnly ? 1 : 0) + contactType.size + (noPaymentOnly ? 1 : 0) + (tier ? 1 : 0) + (recency ? 1 : 0) + (launched ? 1 : 0) + (q ? 1 : 0);

  // Export the FULL filtered set from the server (every matching row + full field set), not just the
  // page on screen — this also closes the old unmetered client-side export. POST the active filters.
  const [exporting, setExporting] = useState(false);
  // How many rows THIS click would export: the ticked rows, or the whole filtered set.
  const pendingRows = picked.size > 0 ? picked.size : data.total;
  const overAllowance = usage?.remaining != null && pendingRows > usage.remaining;
  // Metered plans show what's left; unmetered ones show what's been used. Both read from the
  // plan, so adding a tier needs no change here.
  const usageLabel = !usage
    ? null
    : usage.limit == null
      ? `${usage.used.toLocaleString()} leads exported this month · ${usage.planLabel}`
      : `${(usage.remaining ?? 0).toLocaleString()} of ${usage.limit.toLocaleString()} leads left this month · ${usage.planLabel}`;

  // Both export surfaces report what the download cost and what is left.
  const noteRemaining = (rows: string | null, remaining: string | null) => {
    const n = Number(rows);
    setUsage((u) => {
      if (!u) return u;
      const used = Number.isFinite(n) ? u.used + n : u.used;
      const left = remaining == null || remaining === "unmetered" ? null : Number(remaining);
      return { ...u, used, remaining: left == null || Number.isNaN(left) ? u.remaining : left };
    });
  };

  const exportCsv = async () => {
    setExporting(true);
    setExportMsg("");
    try {
      // Ticked rows → export just those; nothing ticked → the whole filtered set.
      const body = picked.size > 0 ? { domains: [...picked] } : filters;
      const res = await fetch("/api/explore-export", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // The server is the only authority on quota; surface its exact wording (it names
        // how many rows are left) rather than guessing client-side.
        const j = await res.json().catch(() => ({}));
        setExportMsg(j.error ?? "Export failed");
        if (j.quota && typeof j.remaining === "number") {
          setUsage((u) => (u ? { ...u, remaining: j.remaining, used: (u.limit ?? 0) - j.remaining } : u));
        }
        return;
      }
      noteRemaining(res.headers.get("X-Export-Rows"), res.headers.get("X-Export-Remaining"));
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `terrain-leads-${picked.size > 0 ? picked.size : data.total}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } finally { setExporting(false); }
  };

  // Export the same filtered set straight into a Google Sheet the user has shared with our service
  // account (so it lands live in their Drive, not a download). Sheet URL is remembered per browser.
  const [sheetBusy, setSheetBusy] = useState(false);
  const exportSheet = async () => {
    const SA = "shopify-radar@shopify-radar-503921.iam.gserviceaccount.com";
    const saved = (() => { try { return localStorage.getItem("terrainSheetUrl") || ""; } catch { return ""; } })();
    const sheet = window.prompt(`Paste a Google Sheet URL to export into.\n\nFirst share the sheet (Editor) with:\n${SA}`, saved);
    if (!sheet || !sheet.trim()) return;
    setSheetBusy(true);
    try {
      const body = { sheet: sheet.trim(), filters: picked.size > 0 ? { domains: [...picked] } : filters };
      const res = await fetch("/api/leads/export-sheet", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setExportMsg(j.error || "Export failed"); return; }
      if (typeof j.rows === "number") noteRemaining(String(j.rows), j.remaining == null ? "unmetered" : String(j.remaining));
      try { localStorage.setItem("terrainSheetUrl", sheet.trim()); } catch { /* private window */ }
      window.open(j.url as string, "_blank");
    } finally { setSheetBusy(false); }
  };

  // Saved lists — capture the whole current view (the exact shape the Explorer re-seeds from).
  const currentView = (): ExploreInitial => {
    const arr = (s: Set<string>) => (s.size ? [...s] : undefined);
    return {
      q: q || undefined, country: arr(country), category: arr(category), band: arr(band),
      theme: arr(theme), city: arr(city), payment: arr(payment), shipping: arr(shipping),
      activity: arr(activity), platform: arr(platform), apps: arr(app), plugins: arr(plugin), tech: arr(tech), hosting: arr(hosting),
      plus: plusOnly || undefined, email: emailOnly || undefined, tier: tier || undefined,
      reachable: reachableOnly || undefined, contactType: arr(contactType),
      recency: recency || undefined, launched: launched || undefined, noPayment: noPaymentOnly || undefined,
      sort: sort !== "new" ? sort : undefined,
    };
  };
  const [saving, setSaving] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [listName, setListName] = useState("");
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const saveList = async () => {
    if (!listName.trim() || saving) return;
    setSaving(true); setSavedMsg(null);
    const r = await saveListAction(listName.trim(), currentView() as Record<string, unknown>, data.total);
    setSaving(false);
    if (r.ok) { setSavedMsg(`Saved “${listName.trim()}”`); setSaveOpen(false); setListName(""); setTimeout(() => setSavedMsg(null), 2600); }
  };

  // Platform-aware filter visibility: Shopify-only controls (Plus, the Shopify app-store facet) show
  // only when Shopify is in the filter; Hosting shows only for self-hosted platforms, since for SaaS
  // platforms (Shopify/Wix) the host is always the vendor and tells you nothing.
  // Platform values come in mixed case ('shopify' from discovery, 'Wix' from imports), so compare
  // case-insensitively — otherwise selecting "Shopify" wouldn't reveal the Plus / Apps controls.
  const shopifySelected = [...platform].some((p) => p.toLowerCase() === "shopify");
  const wooSelected = [...platform].some((p) => p.toLowerCase() === "woocommerce");
  const openSourceSelected = [...platform].some((p) => OPEN_SOURCE_PLATFORMS.includes(p.toLowerCase()));

  return (
    <div className="flex min-h-screen gap-0">
      {/* filter rail */}
      <aside className="w-64 shrink-0 border-r border-cream/10 px-4 py-5">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-cream">Filters {activeCount > 0 && <span className="ml-1 rounded-full bg-cyan/20 px-1.5 text-xs text-cyan">{activeCount}</span>}</span>
          {activeCount > 0 && <button onClick={clearAll} className="text-xs text-cream/45 hover:text-cream">Clear all</button>}
        </div>
        {/* Country + CMS are the primary filters — they lead the rail, and keep all options visible
            (countryFacet/platformFacet) so you can multi-select across them. */}
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
          <button onClick={() => setReachableOnly((p) => !p)} title="A named person's address, or a decision-maker's role mailbox — not the info@ queue" className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${reachableOnly ? "bg-mint/20 text-cream" : "text-cream/70 hover:bg-cream/[0.05]"}`}>
            <span className={`h-3 w-3 rounded border ${reachableOnly ? "border-mint bg-mint" : "border-cream/25"}`} /> Reaches a person
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
        <Section title="Newly discovered">
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
        </Section>

        {/* Launched — when the store started selling. Single-select (nested windows). */}
        {hasLaunchData && (
          <Section title="Launched">
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
          </Section>
        )}

        {/* Secondary facets — collapsed by default to keep the rail compact (they auto-open when they
            hold a selection). WooCommerce-specific controls (Woo activity) show only when WooCommerce
            is selected; Hosting only for self-hosted platforms; the Shopify app facet only for Shopify;
            City only once a country is chosen (city lists are meaningless across every market at once). */}
        {wooSelected && facets.activity.length > 0 && <Facet title="Woo activity" values={facets.activity} selected={activity} onToggle={toggle(setActivity)} label={(v) => ACTIVITY_LABEL[v] ?? v} defaultOpen={false} />}
        {openSourceSelected && facets.hosting.length > 1 && <Facet title="Hosting" values={facets.hosting} selected={hosting} onToggle={toggle(setHosting)} defaultOpen={false} />}
        <Facet title="Revenue" values={facets.band} selected={band} onToggle={toggle(setBand)} defaultOpen={false} />
        <Facet title="Category" values={facets.category} selected={category} onToggle={toggle(setCategory)} defaultOpen={false} />
        <Facet title="Theme" values={facets.theme} selected={theme} onToggle={toggle(setTheme)} defaultOpen={false} />
        {facets.contactType.length > 0 && <Facet title="Contact quality" values={facets.contactType} selected={contactType} onToggle={toggle(setContactType)} label={(v) => CONTACT_LABEL[v] ?? v} defaultOpen={false} />}
        <Facet title="Payment" values={facets.payment} selected={payment} onToggle={toggle(setPayment)} defaultOpen={false} />
        <Facet title="Shipping" values={facets.shipping} selected={shipping} onToggle={toggle(setShipping)} defaultOpen={false} />
        {shopifySelected && <Facet title="Apps" values={facets.apps} selected={app} onToggle={toggle(setApp)} defaultOpen={false} />}
        {facets.plugins.length > 0 && <Facet title="Plugins" values={facets.plugins} selected={plugin} onToggle={toggle(setPlugin)} defaultOpen={false} />}
        {facets.tech.length > 0 && <Facet title="Technologies" values={facets.tech} selected={tech} onToggle={toggle(setTech)} defaultOpen={false} />}
        {country.size > 0 && <Facet title="City" values={facets.city} selected={city} onToggle={toggle(setCity)} defaultOpen={false} />}
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
            {/* "Has an email" was never the useful number — a generic inbox counts toward it. This
                tile counts the stores whose contact actually reaches a person, with the email
                total kept underneath for context. */}
            <div className="rounded-3xl border border-cream/15 p-5">
              <div className="font-display text-4xl tabular-nums">{liveStats.reachable.toLocaleString()}</div>
              <div className="mt-1 text-xs font-semibold uppercase tracking-wide text-cream/50">Reaches a person</div>
              <div className="mt-0.5 text-[11px] text-cream/35">
                {liveStats.email.toLocaleString()} with any email
                {liveStats.willBounce > 0 && <> · <span className="text-orange/70">{liveStats.willBounce.toLocaleString()} will bounce</span></>}
              </div>
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
          <div className="ml-auto flex items-center gap-2">
            {savedMsg && <span className="text-xs text-mint">{savedMsg}</span>}
            {picked.size > 0 && (
              <button onClick={() => setPicked(new Set())} className="text-xs text-cream/50 hover:text-cream">Clear selection</button>
            )}
            <div className="relative">
              <button onClick={() => setSaveOpen((o) => !o)} className="rounded-full border border-cream/15 px-4 py-2 text-sm text-cream/75 transition hover:border-cream/40 hover:text-cream">☆ Save list</button>
              {saveOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setSaveOpen(false)} />
                  <div className="absolute right-0 z-20 mt-2 w-64 rounded-2xl border border-cream/12 bg-ink-deep p-3 shadow-2xl">
                    <div className="text-xs font-medium uppercase tracking-wide text-cream/45">Save this view</div>
                    <p className="mt-1 text-[11px] leading-snug text-cream/40">Saves the current filters as a reusable list ({data.total.toLocaleString()} leads right now).</p>
                    <input autoFocus value={listName} onChange={(e) => setListName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && saveList()} placeholder="e.g. ZA new WooCommerce"
                      className="mt-2 w-full rounded-xl border border-cream/15 bg-cream/[0.03] px-3 py-2 text-sm text-cream placeholder:text-cream/30 outline-none focus:border-mint/60" />
                    <div className="mt-2 flex justify-end gap-2">
                      <button onClick={() => { setSaveOpen(false); setListName(""); }} className="rounded-full px-3 py-1.5 text-xs text-cream/50 hover:text-cream">Cancel</button>
                      <button onClick={saveList} disabled={!listName.trim() || saving} className="rounded-full bg-mint px-4 py-1.5 text-xs font-semibold text-ink transition hover:brightness-105 disabled:opacity-50">{saving ? "Saving…" : "Save"}</button>
                    </div>
                  </div>
                </>
              )}
            </div>
            <button onClick={exportCsv} disabled={exporting || overAllowance} className="rounded-full bg-mint px-4 py-2 text-sm font-medium text-ink transition hover:brightness-105 disabled:opacity-60">
              {exporting ? "Exporting…" : picked.size > 0 ? `Export ${picked.size} selected → CSV` : `Export all ${data.total.toLocaleString()} → CSV`}
            </button>
            <button onClick={exportSheet} disabled={sheetBusy || overAllowance} title="Export the filtered set into a Google Sheet" className="rounded-full border border-cream/20 px-4 py-2 text-sm font-medium text-cream/80 transition hover:text-cream disabled:opacity-60">
              {sheetBusy ? "Exporting…" : "→ Google Sheets"}
            </button>
          </div>
        </div>

        {/* Export allowance. Shown next to the buttons rather than buried in /account, because
            this is the moment the number matters. Over-allowance disables both surfaces and says
            what to do instead — a refusal after a 40k-row query wastes everyone's time. */}
        {(usageLabel || exportMsg) && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            {usageLabel && <span className="text-cream/45">{usageLabel}</span>}
            {overAllowance && usage?.remaining != null && (
              <span className="text-orange/90">
                That&rsquo;s {pendingRows.toLocaleString()} rows and {usage.remaining.toLocaleString()} left — tick up to {usage.remaining.toLocaleString()} rows, or narrow the filters.
              </span>
            )}
            {exportMsg && <span className="text-orange">{exportMsg}</span>}
          </div>
        )}

        <div className={`mt-4 overflow-x-auto rounded-2xl border border-cream/10 transition-opacity ${loading ? "opacity-60" : ""}`}>
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="border-b border-cream/10 text-xs uppercase tracking-wide text-cream/40">
              <tr>
                <th className="w-8 px-3 py-3">
                  <input type="checkbox" aria-label="Select all loaded"
                    checked={rows.length > 0 && rows.every((r) => picked.has(r.domain))}
                    onChange={(e) => setPicked((prev) => {
                      const n = new Set(prev);
                      if (e.target.checked) rows.forEach((r) => n.add(r.domain)); else rows.forEach((r) => n.delete(r.domain));
                      return n;
                    })} />
                </th>
                <th className="px-4 py-3">Store</th><th className="px-4 py-3">Platform</th><th className="px-4 py-3">Category</th><th className="px-4 py-3">Market</th>
                <th className="px-4 py-3">Revenue</th><th className="px-4 py-3">Traffic</th><th className="px-4 py-3">Catalog</th><th className="px-4 py-3">Fit</th><th className="px-4 py-3">Contacts</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => {
                const b = l.band;
                const bd = bandDisplay(l.band, l.country);
                return (
                  <tr key={l.domain} onClick={() => setSelected(l.domain)} className={`cursor-pointer border-t border-cream/[0.07] transition hover:bg-cream/[0.05] ${picked.has(l.domain) ? "bg-cyan/[0.06]" : ""}`} title="View all known data">
                    <td className="w-8 px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" aria-label={`Select ${l.name ?? l.domain}`} checked={picked.has(l.domain)} onChange={() => togglePick(l.domain)} />
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <div className="shrink-0"><Logo domain={l.domain} name={l.name} /></div>
                        <div className="min-w-0 max-w-[260px]">
                          <div className="flex items-center gap-1.5 font-medium text-cream">
                            <span className="truncate">{l.name ?? l.domain}</span>
                            {l.plus && <span className="shrink-0 rounded bg-lilac/20 px-1 py-0.5 text-[8px] font-bold text-lilac">PLUS</span>}
                            {l.activityTier && l.activityTier !== "not_a_store" && (
                              <span className={`shrink-0 rounded px-1 py-0.5 text-[8px] font-bold uppercase ${l.activityTier === "selling" ? "bg-mint/20 text-mint" : l.activityTier === "active" ? "bg-cyan/20 text-cyan" : "bg-orange/20 text-orange"}`}>{l.activityTier}</span>
                            )}
                          </div>
                          {/* External site link — stop the row's drawer-open when clicked. */}
                          <a href={`https://${l.domain}`} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="block truncate font-mono text-xs text-cream/40 hover:underline">{l.domain}</a>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-cream/70">{l.platform ? platformLabel(l.platform) : "—"}</td>
                    <td className="px-4 py-2.5 text-cream/60">{l.category ?? "—"}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-cream/70">{l.country ? marketLabel(l.country) : "—"}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${bandTone(b)}`}>{bd.local}</span>
                      <span className="ml-1 text-xs text-cream/30">{bd.usd}</span>
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      {l.cruxRank == null
                        ? <span className="text-xs text-cream/30">unranked</span>
                        : <span className="flex items-baseline gap-1.5">
                            <span className="rounded-full border border-cream/15 bg-cream/5 px-2 py-0.5 text-xs font-medium text-cream/80">{rankLabel(l.cruxRank)}</span>
                            {l.cruxTrend && l.cruxTrend !== "flat"
                              ? <span className={trendTone(l.cruxTrend)} title={`${l.cruxTrend} vs the previous CrUX month`}>{trendGlyph(l.cruxTrend)}</span>
                              : null}
                            {l.cruxRankMonth
                              ? <span className="text-[11px] text-cream/35" title="CrUX month this ranking is from">{monthLabel(l.cruxRankMonth)}</span>
                              : null}
                          </span>}
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

/** CrUX ranks are log10 BUCKETS (1000 = "in the top 1,000 origins for this country"), not an
 *  exact position — label them as such so nobody reads 50000 as 50,000th. */
function rankLabel(rank: number): string {
  if (rank >= 1_000_000) return "top 1M";
  if (rank >= 1_000) return `top ${rank / 1_000}k`;
  return `top ${rank}`;
}
/** "202608" -> "Aug '26". This is the freshness of the ranking, not of our record. */
function monthLabel(m: string): string {
  if (!/^\d{6}$/.test(m)) return m;
  const mm = Number(m.slice(4, 6));
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[mm - 1] ?? m.slice(4, 6)} '${m.slice(2, 4)}`;
}
const trendGlyph = (t: string) => (t === "up" ? "▲" : t === "down" ? "▼" : t === "new" ? "✦" : "");
const trendTone = (t: string) =>
  t === "up" ? "text-[11px] text-emerald-400" : t === "down" ? "text-[11px] text-rose-400" : "text-[11px] text-sky-400";
