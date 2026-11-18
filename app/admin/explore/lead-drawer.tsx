"use client";

import { useEffect, useState } from "react";
import { marketLabel, marketFlag } from "@/lib/markets";
import type { LeadDetail } from "@/lib/lead-detail";
import { normalizeTechStack } from "@/lib/tech-stack";
import { isOpenSource } from "@/lib/platforms";
import { socialUrl, socialLabel } from "@/lib/social";
import { NOT_TRADING, dnsStackTools, emailProviderLabel } from "@/lib/store-signals";
import { REVENUE_BANDS, bandMidpointLocal, bandDisplay, revenueBand, floorBand, toUsd, type RevenueBand } from "@/lib/fx";
import { updateStore, type StorePatch } from "./store-edit-action";

const fmtDate = (v: string | null) => (v ? new Date(v).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : null);
const fmtMonth = (v: string | null) => (v ? new Date(v).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }) : null);
// Launch dates from StoreLeads are month-precision (stored as first-of-month), so show
// "Dec 2016" not "1 Dec 2016" — don't imply a day we don't actually have. Own-sourced
// (earliest_product) dates are day-precise and shown in full.
const fmtLaunch = (v: string | null, source: string | null) =>
  source === "storeleads_created" ? fmtMonth(v) : fmtDate(v);
const chips = (v: string | null) => (v ? v.split(";").map((x) => x.trim()).filter(Boolean) : []);

// Choose which email to display. Once contact-enrich has visited a store, `contact_email` IS the
// considered answer: the best of every address found across its contact surface, each one
// domain-checked and classified, with the imported `email` in the same ranking. Before that pass
// reaches a store the old rule holds: the imported `email` is authoritative (a personal gmail there
// is a real owner contact), and a scraped address is trusted only when its domain matches the
// store's. Mirrors bestEmailSql in lib/browse.ts, so the list, the export and the drawer agree.
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
  if (d.contact_checked_at && d.contact_email) return d.contact_email;
  if (d.email) return d.email;
  if (d.contact_email && sameOrg(emailDomain(d.contact_email), d.domain)) return d.contact_email;
  return null;
};

// What kind of contact this is, best to worst, and blunt about the bad end: a buyer should see
// "generic inbox" before they spend a send on it, not after.
const CONTACT_META: Record<string, { label: string; tone: string; hint: string }> = {
  named: { label: "Named person", tone: "bg-mint/15 text-mint", hint: "The address reaches an identifiable person" },
  role_targeted: { label: "Decision-maker role", tone: "bg-cyan/15 text-cyan", hint: "owner@ / accounts@ / press@, a mailbox someone senior reads" },
  role_generic: { label: "Generic inbox", tone: "bg-orange/15 text-orange", hint: "info@ / hello@ / support@, goes to a queue" },
  form_only: { label: "Form only", tone: "bg-cream/10 text-cream/60", hint: "No address published; there is a contact form" },
  none: { label: "No contact found", tone: "bg-cream/10 text-cream/45", hint: "Nothing published on the pages we could reach" },
};
const NAME_SOURCE_LABEL: Record<string, string> = {
  copy: "from the site's copy", jsonld: "from the site's structured data",
  atom: "from the blog feed author", llm: "inferred by the local model", manual: "entered by hand",
  linkedin: "from LinkedIn", web: "from a web search",
};
const GUESS_LABEL: Record<string, string> = {
  verified: "pattern inferred · verified deliverable",
  catch_all: "pattern inferred · domain accepts all mail",
};
const ContactBadge = ({ type }: { type: string }) => {
  const m = CONTACT_META[type] ?? { label: type, tone: "bg-cream/10 text-cream/60", hint: "" };
  return <span title={m.hint} className={`rounded-full px-2 py-0.5 text-xs font-semibold ${m.tone}`}>{m.label}</span>;
};
const waLink = (n: string) => `https://wa.me/${n.replace(/[^\d]/g, "")}`;

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

function Chips({ items, tone = "cream", start, title }: { items: string[]; tone?: string; start?: boolean; title?: string }) {
  const c = tone === "mint" ? "bg-mint/15 text-mint" : tone === "cyan" ? "bg-cyan/15 text-cyan" : tone === "lilac" ? "bg-lilac/15 text-lilac"
    : tone === "outline" ? "border border-lilac/35 text-lilac/90" : "bg-cream/10 text-cream/70";
  return (
    <span className={`flex flex-wrap gap-1 ${start ? "" : "justify-end"}`}>
      {items.map((i) => <span key={i} title={title} className={`rounded-full px-2 py-0.5 text-xs ${c}`}>{i}</span>)}
    </span>
  );
}

/** Tools found only in the store's DNS records — the ones the page scan didn't already list. */
const techKey = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, "");
function dnsOnlyTools(stack: string[], dnsTools: string[]): string[] {
  const seen = new Set(stack.map(techKey));
  return dnsStackTools(dnsTools).filter((t) => !seen.has(techKey(t)));
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
/** The edit form's text inputs, grouped the way someone fills them in rather than the order the
 *  columns happen to sit in. Tuple is [form key, label, placeholder]. */
const TEXT_FIELDS = {
  identity: [
    ["name", "Name", "Tekkie Town"],
    ["country", "Country", "ZA \u00b7 2-letter ISO"],
    ["city", "City", "Cape Town"],
    ["category", "Category", "Apparel"],
  ],
  commercial: [
    ["platform", "Platform", "Shopify / WooCommerce / \u2026"],
    ["currency", "Currency", "ZAR \u00b7 3-letter ISO 4217"],
    ["revenue", "Monthly sales", "figure in the store's own currency"],
  ],
  contact: [
    ["contactName", "Contact name", "Luca Bronkowski"],
    ["contactRole", "Contact role", "Founder"],
    ["contactEmail", "Contact email", "luca@tekkietown.co.za"],
    ["contactPhone", "Phone", "+27 21 555 0100"],
    ["contactForm", "Contact form", "https://\u2026/pages/contact"],
  ],
  channels: [
    ["whatsapp", "WhatsApp", "+27821234567"],
    ["linkedin", "LinkedIn", "company handle or full URL"],
    ["instagram", "Instagram", "handle, no @"],
    ["facebook", "Facebook", "page handle"],
    ["tiktok", "TikTok", "handle, no @"],
    ["tagsText", "Tags", "comma-separated"],
  ],
} as const;

/** Section rule inside the edit card — the form is long enough now that unlabelled rows read as
 *  one undifferentiated list. */
function EditGroup({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex items-baseline gap-2 pt-2 first:pt-0">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-cyan/70">{title}</span>
      {hint && <span className="text-[10px] text-cream/30">{hint}</span>}
      <span className="h-px flex-1 bg-cream/10" />
    </div>
  );
}

/** One labelled text input bound to a form key. */
function EditText<T extends Record<string, unknown>>(
  { k, label, ph, form, setForm }:
  { k: string; label: string; ph?: string; form: T; setForm: React.Dispatch<React.SetStateAction<T>> },
) {
  return (
    <label className="flex items-center gap-3">
      <span className="w-28 shrink-0 text-xs text-cream/45">{label}</span>
      <input value={String(form[k] ?? "")} placeholder={ph}
        onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
        className="min-w-0 flex-1 rounded-lg border border-cream/15 bg-cream/[0.04] px-2.5 py-1.5 text-cream outline-none transition placeholder:text-cream/20 focus:border-cyan/60" />
    </label>
  );
}

/** The live_status / activity_tier values an admin may set, mirroring store-edit-action.ts.
 *  off_24 and `inactive` are lane bookkeeping, not human verdicts, so they are not offered — a
 *  store already carrying one shows blank in the picker and keeps it unless something is chosen. */
const LIVE_STATUS_OPTS = ["", "active", "dead", "migrated"];
const LIVE_STATUS_LABEL: Record<string, string> = {
  "": "— leave / never checked",
  active: "Active — trading",
  dead: "Dead — gone (hidden from every customer)",
  migrated: "Migrated — moved platform (hidden too)",
};
const ACTIVITY_TIER_OPTS = ["", "selling", "active", "dormant", "not_a_store"];
const ACTIVITY_TIER_LABEL: Record<string, string> = {
  "": "— leave unset",
  selling: "Selling",
  active: "Active",
  dormant: "Dormant",
  not_a_store: "Not a store (hidden from the lead list)",
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
  type EditForm = {
    name: string; country: string; city: string; category: string; description: string;
    platform: string; currency: string; revenue: string; plus: boolean;
    published: boolean; liveStatus: string; activityTier: string;
    contactName: string; contactRole: string; contactEmail: string; contactPhone: string; contactForm: string;
    // "" = unknown, "yes"/"no" = the two known answers. A string, not a boolean, so the picker can
    // carry the third state the column actually has.
    physicalStore: string; storeAddress: string; shopPhone: string;
    whatsapp: string; linkedin: string; instagram: string; facebook: string; tiktok: string;
    tagsText: string;
  };
  const EMPTY_FORM: EditForm = {
    name: "", country: "", city: "", category: "", description: "",
    platform: "", currency: "", revenue: "", plus: false,
    published: false, liveStatus: "", activityTier: "",
    contactName: "", contactRole: "", contactEmail: "", contactPhone: "", contactForm: "",
    physicalStore: "", storeAddress: "", shopPhone: "",
    whatsapp: "", linkedin: "", instagram: "", facebook: "", tiktok: "",
    tagsText: "",
  };
  const [form, setForm] = useState<EditForm>(EMPTY_FORM);

  function beginEdit() {
    if (!data) return;
    setForm({
      name: data.name ?? "", country: data.country ?? "", city: data.city ?? "",
      category: data.category ?? "", description: data.description ?? "",
      platform: data.platform ?? "", currency: data.currency ?? "",
      revenue: data.estimated_monthly_sales ?? "", plus: Boolean(data.plus),
      published: Boolean(data.published),
      // A lane-internal status (off_24, inactive) is shown as blank rather than offered back as a
      // choice — the picker only carries verdicts a human should be setting.
      liveStatus: LIVE_STATUS_OPTS.includes(data.live_status ?? "") ? (data.live_status ?? "") : "",
      activityTier: ACTIVITY_TIER_OPTS.includes(data.activity_tier ?? "") ? (data.activity_tier ?? "") : "",
      contactName: data.contact_name ?? "", contactRole: data.contact_role ?? "", contactEmail: data.contact_email ?? "",
      contactPhone: data.contact_phone ?? "", contactForm: data.contact_form_url ?? "",
      physicalStore: data.physical_store == null ? "" : data.physical_store ? "yes" : "no",
      storeAddress: data.store_address ?? "", shopPhone: data.phone ?? "",
      whatsapp: data.whatsapp ?? "", linkedin: data.linkedin ?? "",
      instagram: data.instagram ?? "", facebook: data.facebook ?? "", tiktok: data.tiktok ?? "",
      tagsText: (data.tags ?? []).join(", "),
    });
    setSaveErr(null); setEditing(true);
  }
  async function save() {
    if (!data) return;
    setSaving(true); setSaveErr(null);
    const tags = form.tagsText.split(",").map((t) => t.trim()).filter(Boolean);
    const patch: StorePatch = {
      name: form.name || null, country: form.country || null, city: form.city || null,
      category: form.category || null, description: form.description || null,
      platform: form.platform || null, currency: form.currency || null, plus: form.plus,
      published: form.published, estimated_monthly_sales: form.revenue || null, tags,
      live_status: form.liveStatus || null, activity_tier: form.activityTier || null,
      contact_name: form.contactName || null, contact_email: form.contactEmail || null,
      contact_role: form.contactRole || null, contact_phone: form.contactPhone || null,
      contact_form_url: form.contactForm || null,
      physical_store: form.physicalStore === "" ? null : form.physicalStore === "yes",
      store_address: form.storeAddress || null, phone: form.shopPhone || null,
      whatsapp: form.whatsapp || null, linkedin: form.linkedin || null,
      instagram: form.instagram || null, facebook: form.facebook || null, tiktok: form.tiktok || null,
    };
    const res = await updateStore(data.domain, patch);
    setSaving(false);
    if ("error" in res) { setSaveErr(res.error); return; }
    // A manual revenue drops the modeled price (see store-edit-action), so the read-only "Ballpark
    // revenue" row below has to go with it rather than keep showing the model's range.
    const revChanged = (patch.estimated_monthly_sales ?? null) !== (data.estimated_monthly_sales ?? null);
    // Re-read rather than patch locally: the server normalises (country upper-case, phone digits)
    // and stamps contact_source, so this shows exactly what customers will now see. The local mirror
    // is only the fallback when that re-read fails — it has to cover every field the form sends, or
    // a read-only row keeps showing the pre-save value.
    const fresh = await fetch(`/api/lead?domain=${encodeURIComponent(data.domain)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    setData(fresh && !fresh.error ? (fresh as LeadDetail) : ({
      ...data,
      ...(revChanged ? { revenue_band: null, revenue_confidence: null, revenue_ballpark_usd: null } : {}),
      name: patch.name ?? null, country: patch.country ?? null, city: patch.city ?? null,
      category: patch.category ?? null, description: patch.description ?? null,
      platform: patch.platform ?? null, currency: patch.currency ?? null, plus: form.plus,
      published: form.published, estimated_monthly_sales: patch.estimated_monthly_sales ?? null,
      live_status: patch.live_status ?? null, activity_tier: patch.activity_tier ?? null,
      contact_name: patch.contact_name ?? null, contact_email: patch.contact_email ?? null,
      contact_role: patch.contact_role ?? null, contact_phone: patch.contact_phone ?? null,
      contact_form_url: patch.contact_form_url ?? null,
      physical_store: patch.physical_store ?? null, store_address: patch.store_address ?? null,
      phone: patch.phone ?? null,
      whatsapp: patch.whatsapp ?? null, linkedin: patch.linkedin ?? null,
      instagram: patch.instagram ?? null, facebook: patch.facebook ?? null, tiktok: patch.tiktok ?? null,
      tags,
    } as LeadDetail));
    setEditing(false);
  }

  if (!domain) return null;
  // The band the figure in the edit form falls in. Nothing stores a band: the Explorer pill, the
  // revenue sort, the facet counts and the export all derive it from this one figure (revExpr /
  // bandSqlExpr), so the dropdown below is a view of the amount, not a second field.
  const typedLocal = Number(form.revenue);
  const formBand: RevenueBand = revenueBand(
    form.revenue.trim() === "" || !Number.isFinite(typedLocal)
      ? null
      : toUsd(typedLocal, data?.currency ?? null, data?.country ?? null),
  );
  const money = (v: string | null, ccy?: string | null) => (v != null ? `${ccy ? ccy + " " : ""}${Math.round(Number(v)).toLocaleString()}` : null);
  /** Renders whichever shape the column holds. ~70% of stored Instagram and Facebook values are
   *  full URLs, so the old `https://instagram.com/${handle}` concatenation produced
   *  `https://instagram.com/https://www.instagram.com/wayupsports` — a dead link labelled with the
   *  whole URL. lib/social.ts does the unwrapping; a value that names no profile (a post
   *  permalink, a Linktree) renders as nothing rather than as a broken link. */
  const social = (value: string | null, network: "instagram" | "facebook" | "tiktok", followers: number | null) => {
    const href = socialUrl(value, network);
    if (!href) return null;
    return <a href={href} target="_blank" rel="noopener noreferrer" className="text-cyan hover:underline">{socialLabel(value, network)}{followers ? ` · ${followers.toLocaleString()}` : ""}</a>;
  };

  const conf = (c: string | null) => c === "good" ? "text-mint" : c === "medium" ? "text-orange-soft" : "text-cream/40";
  // The Explorer floors the band it DISPLAYS for the curated cohorts (explorer.tsx -> floorBand), so a
  // top-100 store can list a band above the one its figure derives. The drawer is the stewardship
  // view and shows the real band, then names the listed one — otherwise clicking a row that reads
  // "R10m-R25m" opens a drawer reading "R1m-R2.5m" with nothing to explain the jump.
  const cohort = data?.tags?.includes("top-100") ? "top100" as const : data?.tags?.includes("top-500") ? "top500" as const : null;
  const listedBand = data?.revenue_band && cohort ? floorBand(data.revenue_band as RevenueBand, cohort) : null;
  const floored = listedBand && listedBand !== data?.revenue_band ? listedBand : null;
  const trend = (t: string | null) => t === "up" ? "text-mint" : t === "down" ? "text-orange" : "text-cyan";
  const stats = data ? ([
    data.revenue_ballpark_usd != null && data.revenue_band && { label: "Ballpark revenue", accent: "mint", value: String(data.revenue_band),
      sub: (data.revenue_confidence || floored) ? <>
        {data.revenue_confidence && <span className={conf(data.revenue_confidence)}>{data.revenue_confidence} confidence</span>}
        {floored && <span className="text-cream/40">{data.revenue_confidence ? " · " : ""}listed as {floored}</span>}
      </> : undefined },
    // The imported vendor sales estimate often contradicts the traffic-based ballpark (Keedo:
    // R6k–R23k vs R195k), so customers get the ballpark; the estimate is an admin cross-check, or the
    // fallback when there's no ballpark at all.
    data.estimated_monthly_sales != null && (data.canEdit || data.revenue_ballpark_usd == null) && { label: "Monthly sales", accent: "cyan", value: money(data.estimated_monthly_sales, data.currency)!,
      sub: data.est_revenue_usd != null ? `≈ ${money(data.est_revenue_usd, "$")}` : "estimate" },
    data.crux_rank != null && { label: "Traffic", accent: "lilac", value: rankLabel(Number(data.crux_rank)),
      sub: <>{data.crux_trend && data.crux_trend !== "flat" && <span className={`mr-1.5 ${trend(data.crux_trend)}`}>{data.crux_trend === "up" ? "▲" : data.crux_trend === "down" ? "▼" : "●"} {data.crux_trend}</span>}{data.crux_rank_month ? `Chrome UX · ${monthLabel(String(data.crux_rank_month))}` : "Chrome UX"}</> },
    data.product_count != null && { label: "Products", accent: "orange", value: data.product_count.toLocaleString(),
      sub: data.avg_product_price != null ? `avg ${money(data.avg_product_price, data.currency)}` : undefined },
  ].filter(Boolean) as { label: string; value: string; sub?: React.ReactNode; accent: keyof typeof ACCENT }[]) : [];
  const email = data ? bestEmail(data) : null;
  const otherContacts = (data?.contacts ?? []).filter((c) => c.email && c.email !== email);
  // The badge describes the address on screen. contact_type can say "named" because a person was
  // found (LinkedIn, the web) while the only address is still info@, so prefer that address's own kind.
  const emailKind = (email && data?.contacts?.find((c) => c.email === email)?.kind) || data?.contact_type || null;
  const group = data?.group && data.group.others.length > 0 ? data.group : null;
  const stack = data ? normalizeTechStack(data) : [];
  const dnsTools = data?.dns ? dnsOnlyTools(stack, data.dns.tools) : [];
  // Not trading (checkout probe). A Shopify-frozen store is also what verify-liveness marks `dead`
  // (the same 402), so the header shows one badge for it, not "dead" and "frozen" side by side.
  const nt = data?.notTrading ? { ...data.notTrading, meta: NOT_TRADING[data.notTrading.reason] } : null;
  const showLive = !!data?.live_status && data.live_status !== "active" && !(data.live_status === "dead" && nt?.reason === "frozen");

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
                {/* A move is shown next to the platform, not buried in a detail row: the single most
                    useful thing about this store right now is that it just changed platform, which
                    means it is re-choosing payments, apps and agency. */}
                {data?.migrated_from && (
                  <span className="rounded bg-cyan/15 px-1.5 py-0.5 font-medium text-cyan">
                    ← {platName(data.migrated_from)}
                    {data.migrated_at ? ` · ${new Date(data.migrated_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : ""}
                  </span>
                )}
                {data?.plus && <span className="rounded bg-lilac/15 px-1.5 py-0.5 font-semibold text-lilac">⚡ Plus</span>}
                {data?.country && <span className="text-cream/55">{marketFlag(data.country)} {cleanMarket(data.country)}{data.city ? ` · ${data.city}` : ""}</span>}
                {showLive && <span className="rounded bg-orange/15 px-1.5 py-0.5 text-orange">{data!.live_status}</span>}
                {nt && (
                  <span title={`${nt.meta?.hint ?? nt.reason}${nt.observedAt ? ` · checkout probe, ${fmtDate(nt.observedAt)}` : ""}`}
                    className={`rounded px-1.5 py-0.5 ${nt.meta?.hard ? "bg-orange/15 text-orange" : "bg-cream/10 text-cream/55"}`}>
                    {nt.meta?.hard ? "Not trading · " : ""}{nt.meta?.label ?? nt.reason}
                  </span>
                )}
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
                <EditGroup title="Identity" />
                {TEXT_FIELDS.identity.map(([k, label, ph]) => (
                  <EditText key={k} k={k} label={label} ph={ph} form={form} setForm={setForm} />
                ))}
                <label className="flex items-start gap-3">
                  <span className="w-28 shrink-0 pt-1.5 text-xs text-cream/45">Description</span>
                  <textarea value={form.description} rows={2} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                    className="min-w-0 flex-1 resize-y rounded-lg border border-cream/15 bg-cream/[0.04] px-2.5 py-1.5 text-cream outline-none transition focus:border-cyan/60" />
                </label>

                <EditGroup title="Commercial" />
                {TEXT_FIELDS.commercial.map(([k, label, ph]) => (
                  <EditText key={k} k={k} label={label} ph={ph} form={form} setForm={setForm} />
                ))}
                {/* Pick a band instead of inventing a precise figure. Storing the band's MIDPOINT in the
                    store's currency is what makes this work with no new column: revenueBand() and
                    bandSqlExpr() re-derive exactly the band that was picked, so the pill, the revenue
                    sort, the facets and the CSV all agree. Picking a band fills the amount above;
                    typing an amount moves the band here. */}
                <label className="flex items-center gap-3">
                  <span className="w-28 shrink-0 text-xs text-cream/45">Revenue band</span>
                  <select
                    value={formBand}
                    onChange={(e) => {
                      const mid = bandMidpointLocal(e.target.value as RevenueBand, data.country, data.currency);
                      setForm((f) => ({ ...f, revenue: mid == null ? "" : String(mid) }));
                    }}
                    className="min-w-0 flex-1 rounded-lg border border-cream/15 bg-cream/[0.04] px-2.5 py-1.5 text-cream outline-none transition focus:border-cyan/60"
                  >
                    {REVENUE_BANDS.map((b) => (
                      <option key={b} value={b} className="bg-ink-deep">
                        {b === "New" ? "New \u2014 no revenue signal" : `${b} \u00b7 ${bandDisplay(b, data.country).usd}/mo`}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="text-[11px] leading-snug text-cream/35">
                  {formBand === "New"
                    ? "Saves no figure \u2014 the store reads as New until the pipeline prices it again."
                    : `Saves ${data.currency ? data.currency + " " : ""}${typedLocal.toLocaleString()}/mo${
                        typedLocal === bandMidpointLocal(formBand, data.country, data.currency) ? " (band midpoint)" : ""
                      }; bands as ${formBand}.`}
                </p>
                <label className="flex items-center gap-3">
                  <span className="w-28 shrink-0 text-xs text-cream/45">Shopify Plus</span>
                  <input type="checkbox" checked={form.plus} onChange={(e) => setForm((f) => ({ ...f, plus: e.target.checked }))} className="h-4 w-4 accent-cyan" />
                  <span className="text-xs text-cream/50">{form.plus ? "shows the PLUS badge" : "not Plus"}</span>
                </label>

                <EditGroup title="Lifecycle" hint="What makes this row a lead at all" />
                <label className="flex items-center gap-3">
                  <span className="w-28 shrink-0 text-xs text-cream/45">Published</span>
                  <input type="checkbox" checked={form.published} onChange={(e) => setForm((f) => ({ ...f, published: e.target.checked }))} className="h-4 w-4 accent-cyan" />
                  <span className="text-xs text-cream/50">{form.published ? "visible in customer dashboard" : "banked / hidden"}</span>
                </label>
                <label className="flex items-center gap-3">
                  <span className="w-28 shrink-0 text-xs text-cream/45">Live status</span>
                  <select value={form.liveStatus} onChange={(e) => setForm((f) => ({ ...f, liveStatus: e.target.value }))}
                    className="min-w-0 flex-1 rounded-lg border border-cream/15 bg-cream/[0.04] px-2.5 py-1.5 text-cream outline-none transition focus:border-cyan/60">
                    {LIVE_STATUS_OPTS.map((v) => <option key={v} value={v} className="bg-ink-deep">{LIVE_STATUS_LABEL[v]}</option>)}
                  </select>
                </label>
                <label className="flex items-center gap-3">
                  <span className="w-28 shrink-0 text-xs text-cream/45">Activity</span>
                  <select value={form.activityTier} onChange={(e) => setForm((f) => ({ ...f, activityTier: e.target.value }))}
                    className="min-w-0 flex-1 rounded-lg border border-cream/15 bg-cream/[0.04] px-2.5 py-1.5 text-cream outline-none transition focus:border-cyan/60">
                    {ACTIVITY_TIER_OPTS.map((v) => <option key={v} value={v} className="bg-ink-deep">{ACTIVITY_TIER_LABEL[v]}</option>)}
                  </select>
                </label>
                {/* The one edit worth spelling out before it is made: dead/migrated removes the
                    store from every customer view AND files a churn row, which is what Insights
                    counts. Reversible — set it back to Active and the churn row is withdrawn. */}
                {(form.liveStatus === "dead" || form.liveStatus === "migrated") && data.live_status !== form.liveStatus && (
                  <p className="rounded-lg border border-orange/30 bg-orange/[0.07] px-2.5 py-1.5 text-[11px] leading-snug text-orange/90">
                    Marks the store {form.liveStatus}: it leaves every customer&apos;s lead list and is logged as churn
                    {data.live_status === "active" ? ", dated to when we last confirmed it selling" : ""}. The liveness
                    lane will not re-open it — a hand-set verdict is final until you change it back here.
                  </p>
                )}

                <EditGroup title="Contact" />
                {TEXT_FIELDS.contact.map(([k, label, ph]) => (
                  <EditText key={k} k={k} label={label} ph={ph} form={form} setForm={setForm} />
                ))}

                <EditGroup title="Retail presence" hint="Card-present: the split a PSP buys for" />
                <label className="flex items-center gap-3">
                  <span className="w-28 shrink-0 text-xs text-cream/45">Retail store</span>
                  <select value={form.physicalStore} onChange={(e) => setForm((f) => ({ ...f, physicalStore: e.target.value }))}
                    className="min-w-0 flex-1 rounded-lg border border-cream/15 bg-cream/[0.04] px-2.5 py-1.5 text-cream outline-none transition focus:border-cyan/60">
                    <option value="" className="bg-ink-deep">— not assessed</option>
                    <option value="yes" className="bg-ink-deep">Yes — has a shop you can walk into</option>
                    <option value="no" className="bg-ink-deep">No — online only</option>
                  </select>
                </label>
                <label className="flex items-start gap-3">
                  <span className="w-28 shrink-0 pt-1.5 text-xs text-cream/45">Shop address</span>
                  <textarea value={form.storeAddress} rows={2} placeholder="Shop 12, Cavendish Square, Claremont, Cape Town"
                    onChange={(e) => setForm((f) => ({ ...f, storeAddress: e.target.value }))}
                    className="min-w-0 flex-1 resize-y rounded-lg border border-cream/15 bg-cream/[0.04] px-2.5 py-1.5 text-cream outline-none transition placeholder:text-cream/20 focus:border-cyan/60" />
                </label>
                <EditText k="shopPhone" label="Shop phone" ph="+27 21 555 0100" form={form} setForm={setForm} />
                <p className="text-[11px] leading-snug text-cream/35">
                  &ldquo;Not assessed&rdquo; and &ldquo;No&rdquo; are different answers and both are kept. Saving any value here also
                  stops the text-mining model revisiting the store, so your answer stands.
                </p>

                <EditGroup title="Channels & tags" />
                {TEXT_FIELDS.channels.map(([k, label, ph]) => (
                  <EditText key={k} k={k} label={label} ph={ph} form={form} setForm={setForm} />
                ))}
              </div>
              {saveErr && <p className="mt-2 text-xs text-orange">Couldn&apos;t save: {saveErr}</p>}
              <div className="mt-3 flex gap-2">
                <button onClick={save} disabled={saving} className="rounded-full bg-cyan px-4 py-1.5 text-sm font-semibold text-ink-deep transition hover:bg-cyan/90 disabled:opacity-50">{saving ? "Saving…" : "Save changes"}</button>
                <button onClick={() => setEditing(false)} disabled={saving} className="rounded-full border border-cream/15 px-4 py-1.5 text-sm text-cream/60 transition hover:text-cream">Cancel</button>
              </div>
              <p className="mt-2 text-[11px] text-cream/35">Shared data — this changes what every customer sees. Saved as a manual override (survives re-enrichment) and logged. Payments, apps, theme, catalog size and liveness are re-observed by the crawlers, so they aren&rsquo;t editable here.</p>
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
                ["Quality", emailKind ? <ContactBadge type={emailKind} /> : null],
                ["Person", data.contact_name ? (
                  <span className="flex flex-col items-end">
                    <span>{data.contact_name}{data.contact_role ? ` · ${data.contact_role}` : ""}</span>
                    {data.contact_name_source && <span className="text-[11px] text-cream/35">{NAME_SOURCE_LABEL[data.contact_name_source] ?? data.contact_name_source}</span>}
                  </span>
                ) : null],
                ["Email", email ? <a href={`mailto:${email}`} className="font-mono text-[13px] text-cyan hover:underline">{email}</a> : null],
                // The rest of the ranked set: a generic best address often sits above a usable second one.
                ["Also found", otherContacts.length ? otherContacts.map((c) => (
                  <span key={c.email} className="block">
                    <a href={`mailto:${c.email}`} className="font-mono text-[13px] text-cream/70 hover:text-cyan">{c.email}</a>
                    <span className="ml-1.5 text-[11px] text-cream/35">{CONTACT_META[c.kind]?.label ?? c.kind}</span>
                  </span>
                )) : null],
                // A guess is never merged into "Email": it was inferred from the person's name, not published.
                ["Likely personal", data.contact_email_guess && data.contact_email_guess !== email && emailKind !== "named" ? (
                  <span className="flex flex-col items-end">
                    <span className="font-mono text-[13px] italic text-cream/60">{data.contact_email_guess}</span>
                    <span className="text-[11px] text-cream/35">{GUESS_LABEL[data.contact_guess_status ?? ""] ?? "pattern inferred · unverified, may not exist"}</span>
                  </span>
                ) : null],
                ["Deliverable", data.contact_mx_ok == null || !email ? null : data.contact_mx_ok
                  ? <span className="text-mint">yes{data.contact_mx_provider ? ` · ${data.contact_mx_provider}` : ""}</span>
                  : <span className="text-orange" title="The address's domain publishes no MX record, so mail to it bounces">no, will bounce</span>],
                ["Shared mailbox", (data.contact_shared_count ?? 1) > 1
                  ? <span className="text-orange/80" title="Another tracked store uses this address: an agency, head office or aggregator">also on {(data.contact_shared_count ?? 1) - 1} other store{(data.contact_shared_count ?? 1) - 1 === 1 ? "" : "s"}</span>
                  : null],
                // WhatsApp early: in SA it gets answered when email doesn't.
                ["WhatsApp", data.whatsapp ? <a href={waLink(data.whatsapp)} target="_blank" rel="noopener noreferrer" className="font-mono text-[13px] text-mint hover:underline">{data.whatsapp}</a> : null],
                ["Phone", data.contact_phone ? <span className="font-mono text-[13px]">{data.contact_phone}</span> : null],
                // Retail presence sits in Contact rather than a card of its own: for a shop you
                // can walk into, the address and the shop line ARE ways of reaching the merchant.
                ["Retail store", data.physical_store == null
                  ? null
                  : data.physical_store
                    ? <span className="text-mint">yes — card-present</span>
                    : <span className="text-cream/50">online only</span>],
                ["Shop address", data.store_address ? <span className="text-[13px] leading-snug">{data.store_address}</span> : null],
                ["Shop phone", data.phone && data.phone !== data.contact_phone ? <span className="font-mono text-[13px]">{data.phone}</span> : null],
                ["Contact form", data.contact_form_url ? <a href={data.contact_form_url} target="_blank" rel="noopener noreferrer" className="text-cyan hover:underline">open</a> : null],
                // Stored either as a full URL (company or person page) or as a bare company handle.
                // Through the same normaliser as the rest, so company/, in/ and a bare handle all
                // resolve the same way and a trailing slash or ?trk= cannot reach the label.
                ["LinkedIn", socialUrl(data.linkedin, "linkedin") ? (
                  <a href={socialUrl(data.linkedin, "linkedin")!}
                    target="_blank" rel="noopener noreferrer" className="text-cyan hover:underline">
                    {socialLabel(data.linkedin, "linkedin")}
                  </a>
                ) : null],
                ["Instagram", social(data.instagram, "instagram", data.instagram_followers)],
                ["Facebook", social(data.facebook, "facebook", data.facebook_followers)],
                ["TikTok", social(data.tiktok, "tiktok", null)],
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
                ["Hosting", isOpenSource(data.platform) && data.hosting_provider ? `${data.hosting_provider}${data.hosting_asn ? ` · AS${data.hosting_asn}` : ""}` : null],
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

              {(stack.length > 0 || dnsTools.length > 0) && (
                <Card title="Apps & tech">
                  <div className="space-y-1.5 pt-1">
                    {stack.length > 0 && <Chips items={stack} tone="lilac" start />}
                    {/* Outlined = seen only in the store's DNS (SPF, DKIM, verification records): a tool it
                        sends mail through or has an account with, which the page itself doesn't load. */}
                    {dnsTools.length > 0 && <Chips items={dnsTools} tone="outline" start title="Seen in the store's DNS records" />}
                    {dnsTools.length > 0 && <p className="text-[11px] text-cream/35">Outlined: seen in DNS records only</p>}
                  </div>
                </Card>
              )}

              <Card title="Email & domain" fields={[
                ["Email provider", data.dns?.emailProvider ? emailProviderLabel(data.dns.emailProvider, data.domain) : null],
                ["Verified accounts", data.dns?.verified.length ? <Chips items={data.dns.verified} tone="cyan" /> : null],
                ["DNS checked", data.dns && (data.dns.emailProvider || data.dns.verified.length) ? <span className="font-mono text-[13px]">{fmtDate(data.dns.checkedAt)}</span> : null],
              ]} />

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
