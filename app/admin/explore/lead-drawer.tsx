"use client";

import { useEffect, useState } from "react";
import { marketLabel, marketFlag } from "@/lib/markets";
import type { LeadDetail } from "@/lib/lead-detail";
import { normalizeTechStack } from "@/lib/tech-stack";
import { updateStore, type StorePatch } from "./store-edit-action";

const fmtDate = (v: string | null) => (v ? new Date(v).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : null);
const fmtMonth = (v: string | null) => (v ? new Date(v).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }) : null);
// Launch dates from StoreLeads are month-precision (stored as first-of-month), so show
// "Dec 2016" not "1 Dec 2016" — don't imply a day we don't actually have. Own-sourced
// (earliest_product) dates are day-precise and shown in full.
const fmtLaunch = (v: string | null, source: string | null) =>
  source === "storeleads_created" ? fmtMonth(v) : fmtDate(v);
const chips = (v: string | null) => (v ? v.split(";").map((x) => x.trim()).filter(Boolean) : []);

// Choose which email to display. `email` comes from the per-domain data import and is authoritative
// for this store — even when it's a personal gmail/hotmail (a legitimate owner contact) — so it
// wins. `contact_email` is scraped from the homepage and can be a third-party / agency / redirect-
// target address, so it's only trusted as a fallback when its own domain matches the store's.
const emailDomain = (e: string | null): string | null => {
  const m = /@([a-z0-9.-]+\.[a-z]{2,})/i.exec(e ?? "");
  return m ? m[1].toLowerCase() : null;
};
const sameOrg = (emailDom: string | null, storeDomain: string | null): boolean => {
  if (!emailDom || !storeDomain) return false;
  const sd = storeDomain.toLowerCase().replace(/^www\./, "");
  return emailDom === sd || emailDom.endsWith("." + sd) || sd.endsWith("." + emailDom);
};
const bestEmail = (d: LeadDetail): string | null => {
  if (d.email) return d.email;
  if (d.contact_email && sameOrg(emailDomain(d.contact_email), d.domain)) return d.contact_email;
  return null;
};

type Field = [label: string, value: React.ReactNode];
const present = (v: React.ReactNode) => !(v == null || v === "" || (Array.isArray(v) && v.length === 0));

const PLAT_TONE: Record<string, string> = { shopify: "text-cyan bg-cyan/10", woocommerce: "text-lilac bg-lilac/10" };
const platTone = (p: string | null) => PLAT_TONE[(p ?? "").toLowerCase()] ?? "text-mint bg-mint/10";
const platName = (p: string | null) => { const l = (p ?? "").toLowerCase(); return l === "woocommerce" ? "WooCommerce" : l === "shopify" || !l ? "Shopify" : p!.charAt(0).toUpperCase() + p!.slice(1); };
const cleanMarket = (iso: string) => marketLabel(iso).replace(/^[^\p{L}]+/u, "");

// "Built by" provenance — which public signal the builder→store edge came from (attribute-partners.mjs).
const BUILDER_SOURCE: Record<string, string> = {
  portfolio: "portfolio", footer: "site credit", comment: "code comment", generator: "generator", theme: "theme credit",
};
const builderSourceLabel = (s: string) => BUILDER_SOURCE[s] ?? s;

function Chips({ items, tone = "cream", start }: { items: string[]; tone?: string; start?: boolean }) {
  const c = tone === "mint" ? "bg-mint/15 text-mint" : tone === "cyan" ? "bg-cyan/15 text-cyan" : tone === "lilac" ? "bg-lilac/15 text-lilac" : "bg-cream/10 text-cream/70";
  return (
    <span className={`flex flex-wrap gap-1 ${start ? "" : "justify-end"}`}>
      {items.map((i) => <span key={i} className={`rounded-full px-2 py-0.5 text-xs ${c}`}>{i}</span>)}
    </span>
  );
}

// Woo activity tier badge — the "real store vs stale build" reveal, color-coded by strength.
const TIER_META: Record<string, { label: string; tone: string }> = {
  selling: { label: "Selling", tone: "bg-mint/20 text-mint" },
  active: { label: "Active", tone: "bg-cyan/20 text-cyan" },
  dormant: { label: "Dormant", tone: "bg-orange/20 text-orange" },
  not_a_store: { label: "Not a store", tone: "bg-cream/10 text-cream/45" },
};
function TierBadge({ tier, score }: { tier: string; score: number | null }) {
  const m = TIER_META[tier] ?? { label: tier, tone: "bg-cream/10 text-cream/60" };
  return (
    <span className="flex items-center justify-end gap-1.5">
      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${m.tone}`}>{m.label}</span>
      {score != null && <span className="font-mono text-xs text-cream/35">{score}/100</span>}
    </span>
  );
}

/** A Terrain card of label/value rows. Renders nothing when every value is empty, so a store we
 *  know little about gets a short drawer instead of a wall of blank headings. */
function Card({ title, fields, children }: { title: string; fields?: Field[]; children?: React.ReactNode }) {
  const rows = (fields ?? []).filter(([, v]) => present(v));
  if (!rows.length && !children) return null;
  return (
    <section className="rounded-2xl border border-cream/10 bg-cream/[0.02] p-4">
      <h3 className="mb-1.5 font-display text-base text-cream">{title}</h3>
      {rows.length > 0 && (
        <dl className="divide-y divide-cream/[0.06]">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-4 py-2">
              <dt className="shrink-0 text-xs text-cream/45">{label}</dt>
              <dd className="min-w-0 text-right text-sm text-cream/85">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {children}
    </section>
  );
}

const ACCENT: Record<string, { text: string; bar: string }> = {
  mint: { text: "text-mint", bar: "bg-mint" }, cyan: { text: "text-cyan", bar: "bg-cyan" },
  lilac: { text: "text-lilac", bar: "bg-lilac" }, orange: { text: "text-orange", bar: "bg-orange" },
};
/** Headline figure tile — the Overview StatChip look, for values that are already formatted. */
function Stat({ label, value, sub, accent }: { label: string; value: string; sub?: React.ReactNode; accent: keyof typeof ACCENT }) {
  const a = ACCENT[accent];
  return (
    <div className="relative min-w-0 overflow-hidden rounded-2xl border border-cream/10 bg-cream/[0.025] p-3.5">
      <div className={`flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide ${a.text}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${a.bar}`} />{label}
      </div>
      <div className="mt-1.5 truncate font-display text-xl font-bold leading-tight tabular-nums text-cream">{value}</div>
      {sub && <div className="mt-0.5 truncate text-[11px] text-cream/45">{sub}</div>}
      <span className={`absolute inset-x-0 bottom-0 h-[3px] ${a.bar} opacity-90`} />
    </div>
  );
}

/** Slide-in panel showing EVERY field we know about one store. */
export function LeadDrawer({ domain, onClose, onOpen, onShowGroup }: {
  domain: string | null; onClose: () => void; onOpen?: (domain: string) => void;
  /** Filter the Explorer to this group's stores. */
  onShowGroup?: (groupId: string, label: string) => void;
}) {
  const [data, setData] = useState<LeadDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!domain) return;
    setData(null); setErr(null); setLoading(true);
    const ac = new AbortController();
    fetch(`/api/lead?domain=${encodeURIComponent(domain)}`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status === 404 ? "No record found" : "Couldn't load"))))
      .then((d: LeadDetail) => setData(d))
      .catch((e) => { if (e.name !== "AbortError") setErr(e.message); })
      .finally(() => setLoading(false));
    return () => ac.abort();
  }, [domain]);

  // Close on Escape.
  useEffect(() => {
    if (!domain) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [domain, onClose]);

  // --- Admin manual edit (this drawer only renders under the admin-gated /admin/explore) ---
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [form, setForm] = useState<{ name: string; country: string; platform: string; published: boolean; revenue: string; tagsText: string; contactName: string; contactRole: string; contactEmail: string }>(
    { name: "", country: "", platform: "", published: false, revenue: "", tagsText: "", contactName: "", contactRole: "", contactEmail: "" });

  function beginEdit() {
    if (!data) return;
    setForm({
      name: data.name ?? "", country: data.country ?? "", platform: data.platform ?? "",
      published: Boolean(data.published), revenue: data.estimated_monthly_sales ?? "",
      tagsText: (data.tags ?? []).join(", "),
      contactName: data.contact_name ?? "", contactRole: data.contact_role ?? "", contactEmail: data.contact_email ?? "",
    });
    setSaveErr(null); setEditing(true);
  }
  async function save() {
    if (!data) return;
    setSaving(true); setSaveErr(null);
    const tags = form.tagsText.split(",").map((t) => t.trim()).filter(Boolean);
    const patch: StorePatch = {
      name: form.name || null, country: form.country || null, platform: form.platform || null,
      published: form.published, estimated_monthly_sales: form.revenue || null, tags,
      contact_name: form.contactName || null, contact_email: form.contactEmail || null, contact_role: form.contactRole || null,
    };
    const res = await updateStore(data.domain, patch);
    setSaving(false);
    if ("error" in res) { setSaveErr(res.error); return; }
    setData({ ...data, name: patch.name ?? null, country: patch.country ?? null, platform: patch.platform ?? null, published: form.published, estimated_monthly_sales: patch.estimated_monthly_sales ?? null, tags, contact_name: patch.contact_name ?? null, contact_email: patch.contact_email ?? null, contact_role: patch.contact_role ?? null } as LeadDetail);
    setEditing(false);
  }

  if (!domain) return null;
  const money = (v: string | null, ccy?: string | null) => (v != null ? `${ccy ? ccy + " " : ""}${Math.round(Number(v)).toLocaleString()}` : null);
  const social = (handle: string | null, url: string, followers: number | null) =>
    handle ? <a href={url} target="_blank" rel="noopener noreferrer" className="text-cyan hover:underline">{handle}{followers ? ` · ${followers.toLocaleString()}` : ""}</a> : null;

  const conf = (c: string | null) => c === "good" ? "text-mint" : c === "medium" ? "text-orange-soft" : "text-cream/40";
  const trend = (t: string | null) => t === "up" ? "text-mint" : t === "down" ? "text-orange" : "text-cyan";
  const stats = data ? ([
    data.revenue_band && { label: "Ballpark revenue", accent: "mint", value: String(data.revenue_band),
      sub: data.revenue_confidence ? <span className={conf(data.revenue_confidence)}>{data.revenue_confidence} confidence</span> : undefined },
    // The imported vendor sales estimate often contradicts the traffic-based ballpark (Keedo:
    // R6k–R23k vs R195k), so customers get the ballpark; the estimate is an admin cross-check, or the
    // fallback when there's no ballpark at all.
    data.estimated_monthly_sales != null && (data.canEdit || !data.revenue_band) && { label: "Monthly sales", accent: "cyan", value: money(data.estimated_monthly_sales, data.currency)!,
      sub: data.est_revenue_usd != null ? `≈ ${money(data.est_revenue_usd, "$")}` : "estimate" },
    data.crux_rank != null && { label: "Traffic", accent: "lilac", value: rankLabel(Number(data.crux_rank)),
      sub: <>{data.crux_trend && data.crux_trend !== "flat" && <span className={`mr-1.5 ${trend(data.crux_trend)}`}>{data.crux_trend === "up" ? "▲" : data.crux_trend === "down" ? "▼" : "●"} {data.crux_trend}</span>}{data.crux_rank_month ? `Chrome UX · ${monthLabel(String(data.crux_rank_month))}` : "Chrome UX"}</> },
    data.product_count != null && { label: "Products", accent: "orange", value: data.product_count.toLocaleString(),
      sub: data.avg_product_price != null ? `avg ${money(data.avg_product_price, data.currency)}` : undefined },
  ].filter(Boolean) as { label: string; value: string; sub?: React.ReactNode; accent: keyof typeof ACCENT }[]) : [];
  const email = data ? bestEmail(data) : null;
  const group = data?.group && data.group.others.length > 0 ? data.group : null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={data?.name || domain}>
      <div className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={onClose} />
      <aside className="relative z-10 flex h-full w-full max-w-lg flex-col overflow-y-auto border-l border-cream/10 bg-ink-deep shadow-2xl">
        {/* Header — stays put while the cards scroll under it */}
        <header className="sticky top-0 z-10 border-b border-cream/[0.06] bg-ink-deep/95 px-5 pb-4 pt-[max(1.25rem,env(safe-area-inset-top))] backdrop-blur md:px-6">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                {data?.platform && <span className={`rounded px-1.5 py-0.5 font-medium ${platTone(data.platform)}`}>{platName(data.platform)}</span>}
                {data?.plus && <span className="rounded bg-lilac/15 px-1.5 py-0.5 font-semibold text-lilac">⚡ Plus</span>}
                {data?.country && <span className="text-cream/55">{marketFlag(data.country)} {cleanMarket(data.country)}{data.city ? ` · ${data.city}` : ""}</span>}
                {data?.live_status && data.live_status !== "active" && <span className="rounded bg-orange/15 px-1.5 py-0.5 text-orange">{data.live_status}</span>}
              </div>
              <h2 className="truncate font-display text-2xl font-bold tracking-tight text-cream">{data?.name || domain}</h2>
              <a href={`https://${domain}`} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-cream/45 transition hover:text-mint">{domain} ↗</a>
            </div>
            <div className="flex shrink-0 gap-2">
              {data?.canEdit && !editing && <button onClick={beginEdit} className="rounded-full border border-cyan/30 px-3 py-1 text-sm text-cyan/85 transition hover:bg-cyan/10">Edit</button>}
              <button onClick={onClose} aria-label="Close" className="rounded-full border border-cream/15 px-3 py-1 text-sm text-cream/60 transition hover:text-cream">Close</button>
            </div>
          </div>
        </header>

        <div className="space-y-3 px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-4 md:px-6">
          {loading && (
            <div className="space-y-3" aria-label="Loading">
              <div className="grid grid-cols-2 gap-2.5">{[0, 1, 2, 3].map((i) => <div key={i} className="h-[86px] animate-pulse rounded-2xl bg-cream/[0.04]" />)}</div>
              <div className="h-40 animate-pulse rounded-2xl bg-cream/[0.04]" />
            </div>
          )}
          {err && <p className="py-10 text-center text-sm text-orange">{err}</p>}

          {data && editing && (
            <div className="rounded-2xl border border-cyan/25 bg-gradient-to-b from-cyan/[0.06] to-transparent p-4">
              <h3 className="mb-3 font-display text-base text-cream">Edit store <span className="ml-1 font-mono text-[11px] text-cyan/80">admin</span></h3>
              <div className="space-y-2.5 text-sm">
                {([["name", "Name"], ["country", "Country (ISO2)"], ["platform", "Platform"], ["revenue", "Monthly sales (est.)"], ["contactName", "Contact name"], ["contactRole", "Contact role"], ["contactEmail", "Contact email"], ["tagsText", "Tags (comma-sep)"]] as const).map(([k, label]) => (
                  <label key={k} className="flex items-center gap-3">
                    <span className="w-28 shrink-0 text-xs text-cream/45">{label}</span>
                    <input value={String((form as Record<string, unknown>)[k] ?? "")} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
                      className="min-w-0 flex-1 rounded-lg border border-cream/15 bg-cream/[0.04] px-2.5 py-1.5 text-cream outline-none transition focus:border-cyan/60" />
                  </label>
                ))}
                <label className="flex items-center gap-3">
                  <span className="w-28 shrink-0 text-xs text-cream/45">Published</span>
                  <input type="checkbox" checked={form.published} onChange={(e) => setForm((f) => ({ ...f, published: e.target.checked }))} className="h-4 w-4 accent-cyan" />
                  <span className="text-xs text-cream/50">{form.published ? "visible in customer dashboard" : "banked / hidden"}</span>
                </label>
              </div>
              {saveErr && <p className="mt-2 text-xs text-orange">Couldn&apos;t save: {saveErr}</p>}
              <div className="mt-3 flex gap-2">
                <button onClick={save} disabled={saving} className="rounded-full bg-cyan px-4 py-1.5 text-sm font-semibold text-ink-deep transition hover:bg-cyan/90 disabled:opacity-50">{saving ? "Saving…" : "Save changes"}</button>
                <button onClick={() => setEditing(false)} disabled={saving} className="rounded-full border border-cream/15 px-4 py-1.5 text-sm text-cream/60 transition hover:text-cream">Cancel</button>
              </div>
              <p className="mt-2 text-[11px] text-cream/35">Shared data — this changes what every customer sees. Saved as a manual override (survives re-enrichment) and logged.</p>
            </div>
          )}

          {data && (
            <>
              {data.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {data.tags.map((t) => <span key={t} className="rounded-full bg-cyan/10 px-2 py-0.5 text-[11px] text-cyan/80">#{t}</span>)}
                </div>
              )}

              {stats.length > 0 && (
                <div className="grid grid-cols-2 gap-2.5">
                  {stats.map((st, i) => <div key={st.label} className={stats.length % 2 && i === stats.length - 1 ? "col-span-2" : ""}><Stat {...st} /></div>)}
                </div>
              )}

              {group && (
                <section className="rounded-2xl border border-cyan/20 bg-gradient-to-b from-cyan/[0.06] to-transparent p-4">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="flex items-center gap-2 font-display text-base text-cream">
                      <span className="grid h-6 w-6 place-items-center rounded-lg bg-cyan/15 text-xs text-cyan">✦</span> Same operator
                    </h3>
                    <span className="shrink-0 font-mono text-[11px] text-cream/40">{group.sites} stores</span>
                  </div>
                  <p className="mt-1.5 text-xs leading-snug text-cream/50">
                    {group.operatorDomain ? <>Looks run from <span className="font-mono text-cream/75">{group.operatorDomain}</span> — one conversation covers all of them.</> : <>These stores share contact details — likely one operator.</>}
                  </p>
                  <ul className="mt-3 space-y-1.5">
                    {group.others.map((m) => {
                      const inner = (
                        <>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-semibold text-cream">{m.name && m.name !== m.domain ? m.name : m.domain}</span>
                            <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-cream/45">
                              {m.name && m.name !== m.domain && <span className="font-mono">{m.domain}</span>}
                              {m.platform && <span className={`rounded px-1.5 py-px font-medium ${platTone(m.platform)}`}>{platName(m.platform)}</span>}
                              {m.country && <span>{marketFlag(m.country)}</span>}
                            </span>
                            {m.reasons.length > 0 && (
                              <span className="mt-1 flex flex-wrap gap-1">
                                {m.reasons.map((r) => <span key={r} className="rounded-full bg-cream/[0.06] px-1.5 py-px text-[10.5px] text-cream/55">{r}</span>)}
                              </span>
                            )}
                          </span>
                          {onOpen && <span className="shrink-0 font-mono text-cream/30 transition group-hover:translate-x-0.5 group-hover:text-cyan">→</span>}
                        </>
                      );
                      const cls = "group flex w-full items-center gap-3 rounded-xl border border-cream/10 bg-cream/[0.015] p-3 text-left transition";
                      return (
                        <li key={m.domain}>
                          {onOpen
                            ? <button type="button" onClick={() => onOpen(m.domain)} className={`${cls} hover:border-cyan/30 hover:bg-cream/[0.04]`}>{inner}</button>
                            : <div className={cls}>{inner}</div>}
                        </li>
                      );
                    })}
                  </ul>
                  <div className="mt-2 flex items-center justify-between gap-3">
                    {group.sites - 1 > group.others.length
                      ? <p className="font-mono text-[11px] text-cream/35">+{group.sites - 1 - group.others.length} more in this group</p>
                      : <span />}
                    {onShowGroup && (
                      <button type="button" onClick={() => onShowGroup(group.groupId, `${data.name || data.domain}'s group`)}
                        className="shrink-0 rounded-full border border-cyan/30 px-3 py-1 text-xs text-cyan transition hover:bg-cyan/10">
                        Show all {group.sites} in the list →
                      </button>
                    )}
                  </div>
                </section>
              )}

              <Card title="Contact" fields={[
                ["Person", data.contact_name ? `${data.contact_name}${data.contact_role ? ` · ${data.contact_role}` : ""}` : null],
                ["Email", email ? <a href={`mailto:${email}`} className="font-mono text-[13px] text-cyan hover:underline">{email}</a> : null],
                ["Email (guess)", data.contact_email_guess && !data.contact_email ? <span className="font-mono text-[13px]">{data.contact_email_guess}<span className="ml-1.5 text-[11px] text-cream/40">pending{data.contact_mx_ok ? " · MX ok" : ""}</span></span> : null],
                ["Phone", data.contact_phone ? <span className="font-mono text-[13px]">{data.contact_phone}</span> : null],
                ["Instagram", social(data.instagram, `https://instagram.com/${data.instagram}`, data.instagram_followers)],
                ["Facebook", social(data.facebook, `https://facebook.com/${data.facebook}`, data.facebook_followers)],
                ["TikTok", social(data.tiktok, `https://tiktok.com/@${data.tiktok}`, null)],
              ]} />

              <Card title="Payments & shipping" fields={[
                ["Payments", chips(data.payments).length ? <Chips items={chips(data.payments)} tone="mint" /> : null],
                ["Shipping", chips(data.shipping_providers).length ? <Chips items={chips(data.shipping_providers)} tone="cyan" /> : null],
                ["Free shipping", data.free_shipping == null ? null : data.free_shipping ? "Yes" : "No"],
                ["Logistics apps", chips(data.logistics_apps).length ? <Chips items={chips(data.logistics_apps)} /> : null],
              ]} />

              <Card title="Store" fields={[
                ["Built by", data.builtBy ? (
                  <span className="flex items-center justify-end gap-1.5">
                    {data.builtBy.website
                      ? <a href={data.builtBy.website} target="_blank" rel="noopener noreferrer" className="text-cyan hover:underline">{data.builtBy.name}</a>
                      : <span className="text-cream/85">{data.builtBy.name}</span>}
                    <span className="text-[11px] text-cream/40">{builderSourceLabel(data.builtBy.source)}{!data.builtBy.confirmed ? " · unconfirmed" : ""}</span>
                  </span>
                ) : null],
                ["Category", data.category],
                ["Theme", data.theme],
                ["Activity", data.platform === "woocommerce" && data.activity_tier ? <TierBadge tier={data.activity_tier} score={data.activity_score} /> : null],
                [data.platform?.toLowerCase() === "magento" ? "Magento version" : "Woo version", data.platform === "woocommerce" || data.platform?.toLowerCase() === "magento" ? data.platform_version : null],
                ["Hosting", (data.platform === "woocommerce" || data.platform?.toLowerCase() === "magento") && data.hosting_provider ? `${data.hosting_provider}${data.hosting_asn ? ` · AS${data.hosting_asn}` : ""}` : null],
              ]} />

              {data.brands && data.brands.brands.length > 0 && (
                <Card title="Brands stocked">
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {data.brands.brands.map((b) => (
                      <span key={b.key} className="inline-flex items-baseline gap-1 rounded-full border border-orange/20 bg-orange/[0.06] px-2 py-0.5 text-xs text-cream/80">
                        {b.vendor}<span className="font-mono text-[10px] text-cream/40">{b.products}</span>
                      </span>
                    ))}
                    {data.brands.total > data.brands.brands.length && (
                      <span className="px-1 py-0.5 font-mono text-[11px] text-cream/35">+{data.brands.total - data.brands.brands.length} more</span>
                    )}
                  </div>
                </Card>
              )}

              {normalizeTechStack(data).length > 0 && (
                <Card title="Apps & tech">
                  <div className="pt-1"><Chips items={normalizeTechStack(data)} tone="lilac" start /></div>
                </Card>
              )}

              <Card title="Timeline" fields={[
                ["Launched", fmtLaunch(data.launched_at, data.launched_source)],
                ["First product", fmtDate(data.first_product_at)],
                ["Discovered", fmtDate(data.discovered_at)],
                ["First seen", fmtDate(data.first_seen)],
              ].map(([l, v]) => [l, v ? <span className="font-mono text-[13px]">{v}</span> : null] as Field)} />
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

/** CrUX ranks are log10 BUCKETS, not exact positions — label them "top N". */
function rankLabel(rank: number): string {
  if (rank >= 1_000_000) return "top 1M";
  if (rank >= 1_000) return `top ${rank / 1_000}k`;
  return `top ${rank}`;
}
/** "202608" -> "Aug '26" — the freshness of the RANKING, not of our record. */
function monthLabel(m: string): string {
  if (!/^\d{6}$/.test(m)) return m;
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[Number(m.slice(4, 6)) - 1] ?? m.slice(4, 6)} '${m.slice(2, 4)}`;
}
