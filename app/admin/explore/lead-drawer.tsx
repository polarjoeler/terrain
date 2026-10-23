"use client";

import { useEffect, useState } from "react";
import { marketLabel } from "@/lib/markets";
import type { LeadDetail } from "@/lib/lead-detail";

const fmtDate = (v: string | null) => (v ? new Date(v).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : null);
const fmtMonth = (v: string | null) => (v ? new Date(v).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }) : null);
// Launch dates from StoreLeads are month-precision (stored as first-of-month), so show
// "Dec 2016" not "1 Dec 2016" — don't imply a day we don't actually have. Own-sourced
// (earliest_product) dates are day-precise and shown in full.
const fmtLaunch = (v: string | null, source: string | null) =>
  source === "storeleads_created" ? fmtMonth(v) : fmtDate(v);
const chips = (v: string | null) => (v ? v.split(";").map((x) => x.trim()).filter(Boolean) : []);

// Choose which email to display. Once contact-enrich has run, `contact_email` IS the considered
// answer: it is the best of every address found across the store's contact surface, each one
// domain-checked and classified, with the imported `email` thrown into the same ranking. So it
// wins where it exists. Before that pass reaches a store we fall back to the old rule — the
// imported `email` is authoritative for the store (a personal gmail there is a real owner
// contact), and a homepage-scraped address is only trusted when its own domain matches.
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

// What kind of contact this is — the whole point of the contact pass. Ranked best to worst, and
// deliberately blunt about the bad end: a buyer should see "generic inbox" before they spend a
// send on it, not after.
const CONTACT_META: Record<string, { label: string; tone: string; hint: string }> = {
  named: { label: "Named person", tone: "bg-mint/20 text-mint", hint: "The address reaches an identifiable person" },
  role_targeted: { label: "Decision-maker role", tone: "bg-cyan/20 text-cyan", hint: "owner@ / accounts@ / press@ — a mailbox someone senior reads" },
  role_generic: { label: "Generic inbox", tone: "bg-orange/20 text-orange", hint: "info@ / hello@ / support@ — goes to a queue" },
  form_only: { label: "Form only", tone: "bg-cream/10 text-cream/55", hint: "No address published; there is a contact form" },
  none: { label: "No contact found", tone: "bg-cream/10 text-cream/45", hint: "Nothing published on the site we could reach" },
};
const NAME_SOURCE_LABEL: Record<string, string> = {
  copy: "from the site's own copy", jsonld: "from the site's structured data",
  atom: "from the blog feed author", llm: "inferred by the local model",
};

function ContactBadge({ type }: { type: string }) {
  const m = CONTACT_META[type] ?? { label: type, tone: "bg-cream/10 text-cream/60", hint: "" };
  return <span title={m.hint} className={`rounded-full px-2 py-0.5 text-xs font-semibold ${m.tone}`}>{m.label}</span>;
}

const waLink = (n: string) => `https://wa.me/${n.replace(/[^\d]/g, "")}`;

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
            </Section>

            {data.platform === "woocommerce" && (
              <Section title="WooCommerce">
                <Row label="Activity" value={data.activity_tier ? <TierBadge tier={data.activity_tier} score={data.activity_score} /> : null} />
                <Row label="Hosting" value={data.hosting_provider ? `${data.hosting_provider}${data.hosting_asn ? ` · AS${data.hosting_asn}` : ""}` : null} />
                <Row label="Woo version" value={data.platform_version} />
                <Row label="Plugins" value={chips(data.plugins).length ? <Chips items={chips(data.plugins).slice(0, 12)} tone="lilac" /> : null} />
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
              <Row label="Quality" value={data.contact_type ? <ContactBadge type={data.contact_type} /> : null} />
              <Row label="Email" value={bestEmail(data)
                ? <a href={`mailto:${bestEmail(data)}`} className="text-orange">{bestEmail(data)}</a>
                : null} />
              <Row label="Person" value={data.contact_name
                ? <span className="flex flex-col items-end">
                    <span>{data.contact_name}{data.contact_role ? ` · ${data.contact_role}` : ""}</span>
                    {data.contact_name_source
                      ? <span className="text-[11px] text-cream/35">{NAME_SOURCE_LABEL[data.contact_name_source] ?? data.contact_name_source}</span>
                      : null}
                  </span>
                : null} />
              {/* The rest of the ranked set — a generic best address often sits above a usable
                  second one, and throwing those away was the original mistake. */}
              <Row label="Also found" value={(data.contacts ?? [])
                .filter((c) => c.email !== bestEmail(data))
                .map((c) => (
                  <span key={c.email} className="block">
                    <a href={`mailto:${c.email}`} className="text-cream/70 hover:text-orange">{c.email}</a>
                    <span className="ml-1 text-[11px] text-cream/30">{CONTACT_META[c.kind]?.label ?? c.kind} · {c.source}</span>
                  </span>
                ))} />
              {/* WhatsApp first: in SA it gets answered when email doesn't. */}
              <Row label="WhatsApp" value={data.whatsapp
                ? <a href={waLink(data.whatsapp)} target="_blank" rel="noreferrer" className="text-mint">{data.whatsapp}</a>
                : null} />
              <Row label="Phone" value={data.contact_phone} />
              <Row label="Contact form" value={data.contact_form_url
                ? <a href={data.contact_form_url} target="_blank" rel="noreferrer" className="text-orange">open</a>
                : null} />
              {/* Deliverability: an address that cannot receive mail is a bounce whatever its
                  local-part looks like, which is half of what a high-volume sender is asking for. */}
              <Row label="Deliverable" value={data.contact_mx_ok == null ? null : (
                data.contact_mx_ok
                  ? <span className="text-mint">yes{data.contact_mx_provider ? ` · ${data.contact_mx_provider}` : ""}</span>
                  : <span className="text-orange" title="The address's domain publishes no MX record — mail to it will bounce">no — will bounce</span>
              )} />
              {/* The other flavour of bad email: it works, but it is not this merchant's. */}
              <Row label="Shared mailbox" value={(data.contact_shared_count ?? 1) > 1
                ? <span className="text-orange/80" title="Another tracked store uses this same address — an agency, head office or aggregator">
                    also used by {(data.contact_shared_count ?? 1) - 1} other store{(data.contact_shared_count ?? 1) - 1 === 1 ? "" : "s"}
                  </span>
                : null} />
              {/* Deliberately its own row, visually weaker, and never merged into "Email": this
                  address was INFERRED from the person's name, not published by the merchant. The
                  typed verdict above is only worth something if a guess can't be mistaken for it. */}
              <Row label="Likely personal" value={data.contact_email_guess
                ? <span className="flex flex-col items-end">
                    <a href={`mailto:${data.contact_email_guess}`} className="text-cream/60 italic">{data.contact_email_guess}</a>
                    <span className="text-[11px] text-cream/35">
                      {data.contact_guess_status === "verified" ? "pattern inferred · verified deliverable"
                        : data.contact_guess_status === "catch_all" ? "pattern inferred · domain accepts all mail, unprovable"
                        : "pattern inferred · UNVERIFIED, may not exist"}
                    </span>
                  </span>
                : null} />
              <Row label="Checked" value={fmtDate(data.contact_checked_at)} />
            </Section>

            <Section title="Social">
              <Row label="Instagram" value={social(data.instagram, `https://instagram.com/${data.instagram}`, data.instagram_followers)} />
              <Row label="Facebook" value={social(data.facebook, `https://facebook.com/${data.facebook}`, data.facebook_followers)} />
              <Row label="TikTok" value={social(data.tiktok, `https://tiktok.com/@${data.tiktok}`, null)} />
              <Row label="LinkedIn" value={social(data.linkedin, `https://linkedin.com/company/${data.linkedin}`, null)} />
            </Section>

            {cleanApps(data.apps).length > 0 && (
              <Section title="Apps installed">
                <Chips items={cleanApps(data.apps)} tone="lilac" />
              </Section>
            )}

            <Section title="Timeline">
              <Row label="Launched" value={fmtLaunch(data.launched_at, data.launched_source)} />
              <Row label="First product" value={fmtDate(data.first_product_at)} />
              <Row label="Discovered" value={fmtDate(data.discovered_at)} />
              <Row label="First seen" value={fmtDate(data.first_seen)} />
            </Section>

            {((data.migrations?.length ?? 0) > 0 || (data.payment_history?.length ?? 0) > 0) && (
              <Section title="Change history">
                {data.migrations?.map((m, i) => (
                  <Row key={`mig${i}`} label={fmtDate(m.changed_at) ?? "—"} value={`Migrated → ${m.migrated_to ?? "elsewhere"}`} />
                ))}
                {data.payment_history?.map((c, i) => (
                  <Row key={`pay${i}`} label={fmtDate(c.changed_at) ?? "—"} value={payChange(c)} />
                ))}
              </Section>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

/** Render one payment_changes row as a readable line for the drawer's Change history. */
function payChange(c: { old_primary: string | null; new_primary: string | null; added: string | null; removed: string | null; reordered: boolean | null }): string {
  const bits: string[] = [];
  if (c.old_primary && c.new_primary && c.old_primary !== c.new_primary) bits.push(`primary ${c.old_primary} → ${c.new_primary}`);
  if (c.added) bits.push(`+${c.added}`);
  if (c.removed) bits.push(`−${c.removed}`);
  if (!bits.length && c.reordered) bits.push("re-ranked providers");
  return bits.join(" · ") || "payment change";
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
