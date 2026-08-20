"use client";

import { Fragment, useMemo, useState } from "react";
import type { Lead } from "@/lib/leads";
import { classify } from "@/lib/payments-taxonomy";
import {
  foundDate,
  foundWithin,
  isNewThisWeek,
  socialReach,
  sortLeads,
  type SortKey,
} from "@/lib/prioritize";

type Quality = "all" | "email" | "plus" | "social";

const qualityFilters: { key: Quality; label: string }[] = [
  { key: "all", label: "All" },
  { key: "email", label: "With email" },
  { key: "plus", label: "Plus only" },
  { key: "social", label: "Has social" },
];

// Payment-provider filters for payment-company subscribers (fact #3). These only
// mean something where we have a verified gateway list, so every option except
// "any" implies a probed store.
type PayFilter = "any" | "hasGw" | "noBnpl" | "hasBnpl";
const payFilters: { key: PayFilter; label: string; hint: string }[] = [
  { key: "any", label: "Any", hint: "No payment filter" },
  { key: "hasGw", label: "Has gateway", hint: "A verified payment provider on file" },
  { key: "noBnpl", label: "No BNPL", hint: "Takes payments but no buy-now-pay-later — a BNPL prospect" },
  { key: "hasBnpl", label: "Has BNPL", hint: "Already offers a BNPL option" },
];
type ProviderMode = "uses" | "lacks";

const hasBnpl = (l: Lead) => (l.payments ?? []).some((p) => classify(p) === "BNPL");
const hasGateway = (l: Lead) => (l.payments?.length ?? 0) > 0;

type Window = "all" | "week" | "month" | "quarter";

const windows: { key: Window; label: string; days: number | null }[] = [
  { key: "all", label: "All time", days: null },
  { key: "week", label: "Found this week", days: 7 },
  { key: "month", label: "This month", days: 30 },
  { key: "quarter", label: "This quarter", days: 90 },
];

const sorts: { key: SortKey; label: string }[] = [
  { key: "priority", label: "Best prospects" },
  { key: "newest", label: "Newest found" },
  { key: "size", label: "Biggest" },
  { key: "social", label: "Most social" },
  { key: "launched", label: "Newest launched" },
];

// One-click persona views: each sets the filters + sort together, so a
// subscriber lands on the stores that matter to them without fiddling filters.
type Segment = {
  key: string; label: string; hint: string;
  window: Window; quality: Quality; sort: SortKey; pay?: PayFilter;
};
const segments: Segment[] = [
  { key: "fresh", label: "🌱 Fresh launches", hint: "Found this week, newest first", window: "week", quality: "all", sort: "newest" },
  { key: "enterprise", label: "🏢 Enterprise", hint: "Shopify Plus, biggest first", window: "all", quality: "plus", sort: "size" },
  { key: "reach", label: "📣 High reach", hint: "Biggest social audiences", window: "all", quality: "social", sort: "social" },
  { key: "contact", label: "✉️ Ready to contact", hint: "Has email, best prospects first", window: "all", quality: "email", sort: "priority" },
  { key: "biggest", label: "💰 Biggest", hint: "Top by estimated monthly sales", window: "all", quality: "all", sort: "size" },
  { key: "bnpl", label: "💳 BNPL targets", hint: "Takes payments but no BNPL, biggest first", window: "all", quality: "all", sort: "size", pay: "noBnpl" },
];

const PAGE = 25;

export function LeadsTable({
  leads,
  canExport = false,
  exportRemaining = 0,
  isAdmin = false,
}: {
  leads: Lead[];
  canExport?: boolean;
  exportRemaining?: number;
  isAdmin?: boolean;
}) {
  const [quality, setQuality] = useState<Quality>("all");
  const [window, setWindow] = useState<Window>("all");
  const [pay, setPay] = useState<PayFilter>("any");
  const [provider, setProvider] = useState<string>(""); // "" = any provider
  const [providerMode, setProviderMode] = useState<ProviderMode>("uses");
  const [sort, setSort] = useState<SortKey>("priority");
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [remaining, setRemaining] = useState(exportRemaining);
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState("");

  // Providers actually present in the data, most common first — for the
  // "uses / not on" competitor filter.
  const providerOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const l of leads)
      for (const p of l.payments ?? []) counts.set(p, (counts.get(p) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  }, [leads]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const winDays = windows.find((w) => w.key === window)?.days ?? null;
    const filtered = leads.filter((l) => {
      if (quality === "email" && !l.email) return false;
      if (quality === "plus" && !l.plus) return false;
      if (quality === "social" && socialReach(l) <= 0) return false;
      if (pay === "hasGw" && !hasGateway(l)) return false;
      if (pay === "hasBnpl" && !hasBnpl(l)) return false;
      if (pay === "noBnpl" && (!hasGateway(l) || hasBnpl(l))) return false;
      if (provider) {
        const uses = (l.payments ?? []).includes(provider);
        if (providerMode === "uses" && !uses) return false;
        // "not on": a verified store that doesn't list this provider (a switch
        // target) — exclude unprobed stores, where absence tells us nothing.
        if (providerMode === "lacks" && (!hasGateway(l) || uses)) return false;
      }
      if (winDays != null && !foundWithin(l, winDays)) return false;
      if (!needle) return true;
      return (
        l.domain.toLowerCase().includes(needle) ||
        l.name.toLowerCase().includes(needle)
      );
    });
    return sortLeads(filtered, sort);
  }, [leads, quality, window, pay, provider, providerMode, sort, q]);

  const money = (l: Lead) =>
    l.priceMin != null
      ? `${l.currency && l.currency !== "ZAR" ? l.currency + " " : "R"}${l.priceMin}–${l.priceMax}`
      : "—";

  // Genuine discovery date, shown relative ("3d ago") — the real "found first".
  const foundLabel = (l: Lead) => {
    const d = foundDate(l);
    if (!d) return <span className="text-ink/30">—</span>;
    const days = Math.floor((Date.now() - new Date(d).getTime()) / 864e5);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 30) return `${days}d ago`;
    return d;
  };

  // Estimated monthly sales (USD) — a rough StoreLeads rank proxy, shown compactly.
  const compactUsd = (n: number | null | undefined) => {
    if (n == null) return <span className="text-ink/30">—</span>;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `$${Math.round(n / 1e3)}k`;
    return `$${Math.round(n)}`;
  };

  const compactNum = (n?: number | null) =>
    n == null ? null : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`;

  // The richer enrichment fields, surfaced in an expandable detail row so the
  // main table stays readable. Only fields with a value are included.
  const detailPairs = (l: Lead): [string, string][] => {
    const out: [string, string][] = [];
    if (l.priceMin != null) out.push(["Price range", money(l)]);
    if (l.firstProductAt) out.push(["First product", l.firstProductAt]);
    if (l.city) out.push(["City", l.city]);
    if (l.plan) out.push(["Plan", l.plan]);
    if (l.productsSold != null) out.push(["Products sold", l.productsSold.toLocaleString()]);
    if (l.instagram)
      out.push(["Instagram", `@${l.instagram}${l.instagramFollowers ? ` · ${compactNum(l.instagramFollowers)} followers` : ""}`]);
    if (l.facebook)
      out.push(["Facebook", `${l.facebook}${l.facebookFollowers ? ` · ${compactNum(l.facebookFollowers)} followers` : ""}`]);
    if (l.tiktok) out.push(["TikTok", `@${l.tiktok}`]);
    if (l.technologies) out.push(["Technologies", l.technologies]);
    return out;
  };

  const applySegment = (s: Segment) => {
    setWindow(s.window);
    setQuality(s.quality);
    setSort(s.sort);
    setPay(s.pay ?? "any");
    setProvider("");
    setShown(PAGE);
  };
  const activeSegment = segments.find(
    (s) =>
      s.window === window && s.quality === quality && s.sort === sort &&
      (s.pay ?? "any") === pay && !provider,
  )?.key;

  const toggleExpand = (domain: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(domain) ? next.delete(domain) : next.add(domain);
      return next;
    });

  const reset = () => setShown(PAGE);

  const pageRows = rows.slice(0, shown);
  const allPageSelected =
    pageRows.length > 0 && pageRows.every((l) => selected.has(l.domain));

  const toggle = (domain: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(domain) ? next.delete(domain) : next.add(domain);
      return next;
    });
  };
  const toggleAllOnPage = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allPageSelected) pageRows.forEach((l) => next.delete(l.domain));
      else pageRows.forEach((l) => next.add(l.domain));
      return next;
    });
  };

  async function runExport() {
    setExporting(true);
    setExportMsg("");
    try {
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domains: [...selected] }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setExportMsg(j.error ?? "Export failed");
        if (typeof j.remaining === "number") setRemaining(j.remaining);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `terrain-leads-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      const left = Number(res.headers.get("X-Export-Remaining"));
      if (!Number.isNaN(left)) setRemaining(left);
      setSelected(new Set());
    } catch {
      setExportMsg("Network error — try again");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="mt-8 rounded-[2rem] bg-paper p-6 text-ink md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-bold">
          Stores{" "}
          <span className="text-sm font-normal text-ink/45">
            {rows.length.toLocaleString()} of {leads.length.toLocaleString()}
          </span>
        </h2>
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            reset();
          }}
          placeholder="Search store or domain…"
          className="rounded-full border border-ink/15 bg-transparent px-4 py-1.5 text-sm outline-none placeholder:text-ink/35 focus:border-ink/50"
        />
      </div>

      {/* Persona segments — one click sets window + filter + sort together */}
      <div className="mt-5 flex flex-wrap gap-2">
        {segments.map((s) => (
          <button
            key={s.key}
            onClick={() => applySegment(s)}
            title={s.hint}
            className={`rounded-xl px-3.5 py-2 text-sm font-medium transition ${
              activeSegment === s.key
                ? "bg-ink text-cream"
                : "border border-ink/15 text-ink/70 hover:border-ink/40"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Time-window row — keyed off the genuine discovery date */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-ink/40">
          Found
        </span>
        {windows.map((w) => (
          <button
            key={w.key}
            onClick={() => {
              setWindow(w.key);
              reset();
            }}
            className={`rounded-full px-3.5 py-1.5 text-sm transition ${
              window === w.key
                ? "bg-mint text-ink"
                : "border border-ink/15 text-ink/60 hover:border-ink/40"
            }`}
          >
            {w.label}
          </button>
        ))}
      </div>

      {/* Payments row — for payment-company subscribers (verified gateways) */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-ink/40">
          Payments
        </span>
        {payFilters.map((f) => (
          <button
            key={f.key}
            onClick={() => {
              setPay(f.key);
              reset();
            }}
            title={f.hint}
            className={`rounded-full px-3.5 py-1.5 text-sm transition ${
              pay === f.key
                ? "bg-lilac text-ink"
                : "border border-ink/15 text-ink/60 hover:border-ink/40"
            }`}
          >
            {f.label}
          </button>
        ))}
        {providerOptions.length > 0 && (
          <span className="ml-1 flex items-center gap-1.5">
            <select
              value={providerMode}
              onChange={(e) => {
                setProviderMode(e.target.value as ProviderMode);
                reset();
              }}
              className="rounded-full border border-ink/15 bg-transparent px-2.5 py-1.5 text-sm text-ink/70 outline-none focus:border-ink/50"
              aria-label="Provider filter mode"
            >
              <option value="uses">Uses</option>
              <option value="lacks">Not on</option>
            </select>
            <select
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                reset();
              }}
              className="rounded-full border border-ink/15 bg-transparent px-2.5 py-1.5 text-sm text-ink/70 outline-none focus:border-ink/50"
              aria-label="Payment provider"
            >
              <option value="">any provider</option>
              {providerOptions.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </span>
        )}
      </div>

      {/* Quality + sort row */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-ink/40">
          Show
        </span>
        {qualityFilters.map((f) => (
          <button
            key={f.key}
            onClick={() => {
              setQuality(f.key);
              reset();
            }}
            className={`rounded-full px-3.5 py-1.5 text-sm transition ${
              quality === f.key
                ? "bg-ink text-cream"
                : "border border-ink/15 text-ink/60 hover:border-ink/40"
            }`}
          >
            {f.label}
          </button>
        ))}
        <span className="ml-auto mr-1 text-xs font-semibold uppercase tracking-wide text-ink/40">
          Sort
        </span>
        {sorts.map((sopt) => (
          <button
            key={sopt.key}
            onClick={() => setSort(sopt.key)}
            className={`rounded-full px-3.5 py-1.5 text-sm transition ${
              sort === sopt.key
                ? "bg-orange text-cream"
                : "border border-ink/15 text-ink/60 hover:border-ink/40"
            }`}
          >
            {sopt.label}
          </button>
        ))}
      </div>

      {/* export bar */}
      {canExport ? (
        <div className="mt-5 flex flex-wrap items-center gap-3 rounded-2xl bg-ink/[0.04] px-4 py-3">
          <span className="text-sm font-medium">
            {selected.size} selected
          </span>
          <button
            onClick={runExport}
            disabled={selected.size === 0 || exporting || selected.size > remaining}
            className="rounded-full bg-ink px-4 py-1.5 text-sm font-medium text-cream transition hover:bg-ink-deep disabled:opacity-40"
          >
            {exporting ? "Exporting…" : `Export selected (${selected.size})`}
          </button>
          <span className="text-xs text-ink/50">
            {remaining} of 200 exports left this month
          </span>
          {exportMsg && <span className="text-xs text-orange">{exportMsg}</span>}
        </div>
      ) : (
        <div className="mt-5 rounded-2xl border border-ink/10 px-4 py-3 text-sm text-ink/55">
          CSV export of selected stores is a{" "}
          <a href="/billing" className="font-semibold text-orange">Pro</a> feature
          — 200 stores/month.
        </div>
      )}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[980px] text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-ink/40">
            <tr>
              {canExport && (
                <th className="pb-3 pr-3">
                  <input
                    type="checkbox"
                    checked={allPageSelected}
                    onChange={toggleAllOnPage}
                    aria-label="Select all on page"
                  />
                </th>
              )}
              <th className="pb-3 pr-4">Store</th>
              <th className="pb-3 pr-4">Category</th>
              <th className="pb-3 pr-4">Est. revenue</th>
              <th className="pb-3 pr-4">Social reach</th>
              <th className="pb-3 pr-4">Products</th>
              <th className="pb-3 pr-4">Payments</th>
              <th className="pb-3 pr-4">Contact</th>
              <th className="pb-3">Found</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((l) => (
              <Fragment key={l.domain}>
              <tr className="border-t border-ink/10 align-top">
                {canExport && (
                  <td className="py-4 pr-3">
                    <input
                      type="checkbox"
                      checked={selected.has(l.domain)}
                      onChange={() => toggle(l.domain)}
                      aria-label={`Select ${l.name}`}
                    />
                  </td>
                )}
                <td className="py-4 pr-4">
                  <div className="flex flex-wrap items-center gap-1.5 font-semibold">
                    {l.name}
                    {l.plus && (
                      <span className="rounded-full bg-lilac px-2 py-0.5 text-[10px] font-bold">
                        PLUS
                      </span>
                    )}
                    {isNewThisWeek(l) && (
                      <span className="rounded-full bg-mint px-2 py-0.5 text-[10px] font-bold">
                        NEW
                      </span>
                    )}
                  </div>
                  <a
                    href={l.finalUrl ?? `https://${l.domain}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-ink/50 underline-offset-2 hover:underline"
                  >
                    {l.domain}
                  </a>
                  <button
                    onClick={() => toggleExpand(l.domain)}
                    className="mt-1 block text-[11px] font-medium text-ink/40 hover:text-ink/70"
                    aria-expanded={expanded.has(l.domain)}
                  >
                    {expanded.has(l.domain) ? "− less" : "+ details"}
                  </button>
                </td>
                <td className="py-4 pr-4 whitespace-nowrap text-ink/70">
                  {l.category ?? <span className="text-ink/30">—</span>}
                </td>
                <td className="py-4 pr-4 whitespace-nowrap font-medium">
                  {compactUsd(l.estMonthlySales)}
                </td>
                <td className="py-4 pr-4 whitespace-nowrap">
                  {socialReach(l) > 0 ? (
                    <span title="Instagram + Facebook followers">{compactNum(socialReach(l))}</span>
                  ) : (
                    <span className="text-ink/30">—</span>
                  )}
                </td>
                <td className="py-4 pr-4">{l.productCount ?? "—"}</td>
                <td className="py-4 pr-4">
                  {l.payments?.length ? (
                    <div className="flex flex-wrap gap-1">
                      {l.payments.slice(0, 3).map((p) => (
                        <span
                          key={p}
                          className="rounded-full bg-mint/50 px-2 py-0.5 text-[10px] font-medium"
                        >
                          {p}
                        </span>
                      ))}
                      {l.payments.length > 3 && (
                        <span className="text-[10px] text-ink/40">
                          +{l.payments.length - 3}
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="text-ink/30">—</span>
                  )}
                </td>
                <td className="py-4 pr-4">
                  {l.email ? (
                    <a href={`mailto:${l.email}`} className="text-orange">
                      {l.email}
                    </a>
                  ) : (
                    <span className="text-ink/30">—</span>
                  )}
                </td>
                <td className="py-4 whitespace-nowrap text-ink/60">
                  {foundLabel(l)}
                </td>
              </tr>
              {expanded.has(l.domain) && (
                <tr className="align-top">
                  <td colSpan={canExport ? 9 : 8} className="px-1 pb-5">
                    <div className="flex flex-col gap-4 rounded-2xl border border-ink/10 bg-ink/[0.02] p-4 md:flex-row">
                      {isAdmin && (
                        <a
                          href={l.finalUrl ?? `https://${l.domain}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="group relative shrink-0 self-start"
                          title="Open store (screenshot via thum.io)"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={`https://image.thum.io/get/width/400/crop/300/noanimate/https://${l.domain}`}
                            alt={`${l.name} homepage`}
                            loading="lazy"
                            className="h-[150px] w-[200px] rounded-xl border border-ink/10 bg-ink/5 object-cover object-top"
                          />
                          <span className="absolute left-2 top-2 rounded-full bg-ink/70 px-2 py-0.5 text-[10px] font-semibold text-cream">
                            Admin preview
                          </span>
                        </a>
                      )}
                      <div className="min-w-0 flex-1">
                        {detailPairs(l).length > 0 && (
                          <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2 md:grid-cols-3">
                            {detailPairs(l).map(([label, value]) => (
                              <div key={label} className="text-xs">
                                <div className="font-semibold uppercase tracking-wide text-ink/35">
                                  {label}
                                </div>
                                <div className="mt-0.5 break-words text-ink/75">{value}</div>
                              </div>
                            ))}
                          </div>
                        )}
                        {l.description && (
                          <p className="mt-3 max-w-2xl text-xs leading-relaxed text-ink/60">
                            {l.description}
                          </p>
                        )}
                        {detailPairs(l).length === 0 && !l.description && (
                          <p className="text-xs text-ink/40">No additional data for this store yet.</p>
                        )}
                      </div>
                    </div>
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="py-10 text-center text-ink/50">
            No stores match these filters.
          </p>
        )}
      </div>

      {shown < rows.length && (
        <button
          onClick={() => setShown((s) => s + PAGE)}
          className="mt-6 w-full rounded-full border border-ink/15 py-3 text-sm font-medium text-ink/70 transition hover:border-ink/40"
        >
          Show {Math.min(PAGE, rows.length - shown)} more
        </button>
      )}
    </div>
  );
}
