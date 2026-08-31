"use client";

import { useEffect, useState } from "react";
import { marketLabel } from "@/lib/markets";
import type { LeadDetail } from "@/lib/lead-detail";

const fmtDate = (v: string | null) => (v ? new Date(v).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : null);
const chips = (v: string | null) => (v ? v.split(";").map((x) => x.trim()).filter(Boolean) : []);

// How we know the store: our own crawlers (Scanned) vs a data import (Imported).
// Don't leak the raw source name (e.g. "storeleads-2026-08") to the surface.
function sourceLabel(source: string | null): string {
  const s = (source ?? "").toLowerCase();
  if (s === "discovery" || s === "ct_tail" || s === "crawl") return "Scanned";
  if (!s) return "Imported";
  return "Imported";
}

// Apps are stored as raw Shopify app-store URLs (often concatenated). Show the
// clean public-app names — dropping custom/private apps, which have no store URL.
const APP_ALIAS: Record<string, string> = {
  inbox: "Shopify Inbox", "product-reviews": "Shopify Reviews", geolocation: "Shopify Geolocation",
  judgeme: "Judge.me", "klaviyo-email-marketing": "Klaviyo", "customer-privacy-banner": "Privacy Banner",
  "whatsapp-chat-for-support": "WhatsApp Chat", instafeed: "Instafeed", pagefly: "PageFly",
  omnisend: "Omnisend", mailchimp: "Mailchimp",
};
const APP_SKIP = new Set(["partners", "collections", "browse", "categories", "stores"]);
function cleanApps(raw: string | null): string[] {
  if (!raw) return [];
  const slugs = [...raw.matchAll(/apps\.shopify\.com\/([a-z0-9][a-z0-9-]*)/gi)]
    .map((m) => m[1].toLowerCase()).filter((s) => !APP_SKIP.has(s));
  if (slugs.length) {
    return [...new Set(slugs)].map((s) => APP_ALIAS[s] ?? s.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "));
  }
  // Already clean, semicolon-separated names (e.g. from a snapshot) — pass through.
  return chips(raw).filter((x) => /^[A-Za-z][A-Za-z0-9 .&'-]{1,28}$/.test(x));
}

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
          <button onClick={onClose} className="shrink-0 rounded-full border border-cream/20 px-3 py-1 text-sm text-cream/60 transition hover:border-cream/50 hover:text-cream">Close</button>
        </div>

        {loading && <p className="mt-8 text-sm text-cream/40">Loading all known data…</p>}
        {err && <p className="mt-8 text-sm text-orange">{err}</p>}

        {data && (
          <div className="mt-4">
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
              <Row label="Source" value={sourceLabel(data.source)} />
            </Section>

            <Section title="Revenue & catalog">
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
              <Row label="Email" value={data.contact_email || data.email} />
              <Row label="Phone" value={data.contact_phone} />
            </Section>

            <Section title="Social">
              <Row label="Instagram" value={social(data.instagram, `https://instagram.com/${data.instagram}`, data.instagram_followers)} />
              <Row label="Facebook" value={social(data.facebook, `https://facebook.com/${data.facebook}`, data.facebook_followers)} />
              <Row label="TikTok" value={social(data.tiktok, `https://tiktok.com/@${data.tiktok}`, null)} />
            </Section>

            {cleanApps(data.apps).length > 0 && (
              <Section title="Apps installed">
                <Chips items={cleanApps(data.apps)} tone="lilac" />
              </Section>
            )}

            <Section title="Timeline">
              <Row label="Launched" value={fmtDate(data.launched_at)} />
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
