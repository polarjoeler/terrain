"use client";

import { useEffect, useState } from "react";
import { marketLabel } from "@/lib/markets";
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

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) return null;
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="shrink-0 text-xs uppercase tracking-wide text-cream/40">{label}</span>
      <span className="min-w-0 text-right text-sm text-cream/85">{value}</span>
    </div>
  );
}

function Chips({ items, tone = "cream" }: { items: string[]; tone?: string }) {
  const c = tone === "mint" ? "bg-mint/15 text-mint" : tone === "cyan" ? "bg-cyan/15 text-cyan" : tone === "lilac" ? "bg-lilac/15 text-lilac" : "bg-cream/10 text-cream/70";
  return (
    <span className="flex flex-wrap justify-end gap-1">
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
      {score != null && <span className="text-xs text-cream/35 tabular-nums">{score}/100</span>}
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-cream/10 py-3">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-cream/35">{title}</div>
      {children}
    </div>
  );
}

/** Slide-in panel showing EVERY field we know about one store. */
export function LeadDrawer({ domain, onClose }: { domain: string | null; onClose: () => void }) {
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
  const [form, setForm] = useState<{ name: string; country: string; platform: string; published: boolean; revenue: string; tagsText: string }>(
    { name: "", country: "", platform: "", published: false, revenue: "", tagsText: "" });

  function beginEdit() {
    if (!data) return;
    setForm({
      name: data.name ?? "", country: data.country ?? "", platform: data.platform ?? "",
      published: Boolean(data.published), revenue: data.estimated_monthly_sales ?? "",
      tagsText: (data.tags ?? []).join(", "),
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
    };
    const res = await updateStore(data.domain, patch);
    setSaving(false);
    if ("error" in res) { setSaveErr(res.error); return; }
    setData({ ...data, name: patch.name ?? null, country: patch.country ?? null, platform: patch.platform ?? null, published: form.published, estimated_monthly_sales: patch.estimated_monthly_sales ?? null, tags } as LeadDetail);
    setEditing(false);
  }

  if (!domain) return null;
  const money = (v: string | null, ccy?: string | null) => (v != null ? `${ccy ? ccy + " " : ""}${Number(v).toLocaleString()}` : null);
  const social = (handle: string | null, url: string, followers: number | null) =>
    handle ? <a href={url} target="_blank" rel="noopener noreferrer" className="text-cyan hover:underline">{handle}{followers ? ` · ${followers.toLocaleString()}` : ""}</a> : null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <aside className="relative z-10 flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-cream/15 bg-ink-deep p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate font-display text-2xl text-cream">{data?.name || domain}</h2>
            <a href={`https://${domain}`} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-cream/45 hover:underline">{domain} ↗</a>
          </div>
          <div className="flex shrink-0 gap-2">
            {data && !editing && <button onClick={beginEdit} className="rounded-full border border-cyan/40 px-3 py-1 text-sm text-cyan/80 transition hover:border-cyan hover:text-cyan">Edit</button>}
            <button onClick={onClose} className="rounded-full border border-cream/20 px-3 py-1 text-sm text-cream/60 transition hover:border-cream/50 hover:text-cream">Close</button>
          </div>
        </div>

        {loading && <p className="mt-8 text-sm text-cream/40">Loading all known data…</p>}
        {err && <p className="mt-8 text-sm text-orange">{err}</p>}

        {data && editing && (
          <div className="mt-4 rounded-2xl border border-cyan/30 bg-cyan/[0.05] p-4">
            <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-cyan/80">Edit store · admin</div>
            <div className="space-y-2.5 text-sm">
              {([["name", "Name"], ["country", "Country (ISO2)"], ["platform", "Platform"], ["revenue", "Monthly sales (est.)"], ["tagsText", "Tags (comma-sep)"]] as const).map(([k, label]) => (
                <label key={k} className="flex items-center gap-3">
                  <span className="w-28 shrink-0 text-xs uppercase tracking-wide text-cream/40">{label}</span>
                  <input value={String((form as Record<string, unknown>)[k] ?? "")} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
                    className="min-w-0 flex-1 rounded-lg border border-cream/20 bg-cream/[0.04] px-2.5 py-1 text-cream outline-none focus:border-cyan/60" />
                </label>
              ))}
              <label className="flex items-center gap-3">
                <span className="w-28 shrink-0 text-xs uppercase tracking-wide text-cream/40">Published</span>
                <input type="checkbox" checked={form.published} onChange={(e) => setForm((f) => ({ ...f, published: e.target.checked }))} className="h-4 w-4 accent-cyan" />
                <span className="text-xs text-cream/50">{form.published ? "visible in customer dashboard" : "banked / hidden"}</span>
              </label>
            </div>
            {saveErr && <p className="mt-2 text-xs text-orange">Couldn&apos;t save: {saveErr}</p>}
            <div className="mt-3 flex gap-2">
              <button onClick={save} disabled={saving} className="rounded-full bg-cyan px-4 py-1.5 text-sm font-semibold text-ink-deep transition hover:bg-cyan/90 disabled:opacity-50">{saving ? "Saving…" : "Save changes"}</button>
              <button onClick={() => setEditing(false)} disabled={saving} className="rounded-full border border-cream/20 px-4 py-1.5 text-sm text-cream/60 transition hover:border-cream/50 hover:text-cream">Cancel</button>
            </div>
            <p className="mt-2 text-[11px] text-cream/35">Shared data — this changes what every customer sees. Saved as a manual override (survives re-enrichment) and logged.</p>
          </div>
        )}

        {data && (
          <div className="mt-4">
            {data.tags.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {data.tags.map((t) => <span key={t} className="rounded-full bg-cyan/10 px-2 py-0.5 text-[11px] text-cyan/80">#{t}</span>)}
              </div>
            )}
            <div className="flex flex-wrap gap-1.5">
              {data.country && <span className="rounded-full bg-cream/10 px-2.5 py-0.5 text-xs text-cream/70">{marketLabel(data.country)}</span>}
              {data.plus && <span className="rounded-full bg-lilac/20 px-2.5 py-0.5 text-xs font-bold text-lilac">⚡ Plus</span>}
              {data.live_status && data.live_status !== "active" && <span className="rounded-full bg-orange/20 px-2.5 py-0.5 text-xs text-orange">{data.live_status}</span>}
            </div>

            <Section title="Overview">
              <Row label="Category" value={data.category} />
              <Row label="City" value={data.city} />
              <Row label="Theme" value={data.theme} />
              <Row label="Platform" value={data.platform} />
            </Section>

            {data.platform === "woocommerce" && (
              <Section title="WooCommerce">
                <Row label="Activity" value={data.activity_tier ? <TierBadge tier={data.activity_tier} score={data.activity_score} /> : null} />
                <Row label="Hosting" value={data.hosting_provider ? `${data.hosting_provider}${data.hosting_asn ? ` · AS${data.hosting_asn}` : ""}` : null} />
                <Row label="Woo version" value={data.platform_version} />
              </Section>
            )}

            {data.platform?.toLowerCase() === "magento" && (
              <Section title="Magento / Adobe Commerce">
                <Row label="Magento version" value={data.platform_version} />
                <Row label="Hosting" value={data.hosting_provider ? `${data.hosting_provider}${data.hosting_asn ? ` · AS${data.hosting_asn}` : ""}` : null} />
              </Section>
            )}

            <Section title="Revenue & catalog">
              <Row label="Ballpark revenue" value={data.revenue_band
                ? <span className="flex items-baseline gap-2">
                    <span>{String(data.revenue_band)}</span>
                    {data.revenue_confidence
                      ? <span className={`text-[11px] ${data.revenue_confidence === "good" ? "text-emerald-400" : data.revenue_confidence === "medium" ? "text-amber-400" : "text-cream/35"}`}>
                          {String(data.revenue_confidence)} confidence
                        </span>
                      : null}
                  </span>
                : null} />
              <Row label="Traffic rank" value={data.crux_rank != null
                ? <span className="flex items-baseline gap-2">
                    <span>{rankLabel(Number(data.crux_rank))}</span>
                    {data.crux_trend && data.crux_trend !== "flat"
                      ? <span className={`text-[11px] ${data.crux_trend === "up" ? "text-emerald-400" : data.crux_trend === "down" ? "text-rose-400" : "text-sky-400"}`}>
                          {String(data.crux_trend)}
                        </span>
                      : null}
                    {data.crux_rank_month
                      ? <span className="text-[11px] text-cream/35">updated {monthLabel(String(data.crux_rank_month))}</span>
                      : null}
                  </span>
                : null} />
              <Row label="Est. monthly sales" value={money(data.estimated_monthly_sales, data.currency)} />
              <Row label="Est. revenue (USD)" value={money(data.est_revenue_usd, "$")} />
              <Row label="Products" value={data.product_count != null ? data.product_count.toLocaleString() : null} />
              <Row label="Avg price" value={money(data.avg_product_price, data.currency)} />
            </Section>

            <Section title="Payments & shipping">
              <Row label="Payments" value={chips(data.payments).length ? <Chips items={chips(data.payments)} tone="mint" /> : null} />
              <Row label="Shipping" value={chips(data.shipping_providers).length ? <Chips items={chips(data.shipping_providers)} tone="cyan" /> : null} />
              <Row label="Free shipping" value={data.free_shipping == null ? null : data.free_shipping ? "Yes" : "No"} />
              <Row label="Logistics apps" value={chips(data.logistics_apps).length ? <Chips items={chips(data.logistics_apps)} /> : null} />
            </Section>

            <Section title="Contact">
              <Row label="Email" value={bestEmail(data)} />
              <Row label="Phone" value={data.contact_phone} />
            </Section>

            <Section title="Social">
              <Row label="Instagram" value={social(data.instagram, `https://instagram.com/${data.instagram}`, data.instagram_followers)} />
              <Row label="Facebook" value={social(data.facebook, `https://facebook.com/${data.facebook}`, data.facebook_followers)} />
              <Row label="TikTok" value={social(data.tiktok, `https://tiktok.com/@${data.tiktok}`, null)} />
            </Section>

            {normalizeTechStack(data).length > 0 && (
              <Section title="Apps & tech">
                <Chips items={normalizeTechStack(data)} tone="lilac" />
              </Section>
            )}

            <Section title="Timeline">
              <Row label="Launched" value={fmtLaunch(data.launched_at, data.launched_source)} />
              <Row label="First product" value={fmtDate(data.first_product_at)} />
              <Row label="Discovered" value={fmtDate(data.discovered_at)} />
              <Row label="First seen" value={fmtDate(data.first_seen)} />
            </Section>
          </div>
        )}
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
