import { redirect } from "next/navigation";
import Link from "next/link";
import { currentUser, isAdmin } from "@/lib/auth";
import { coverageMatrix, rangeActivity, type CoverageRow, type PlatCoverage } from "@/lib/ops";
import { countryEmoji, countryName, regionOf, REGION_ORDER } from "@/lib/countries";
import { RangeFilter } from "./range-filter";

type CmsSel = "all" | "shopify" | "woo" | "other";
const CMS_TABS: { key: CmsSel; label: string; dot: string }[] = [
  { key: "all", label: "All CMS", dot: "#8fb0c4" },
  { key: "shopify", label: "Shopify", dot: "#95BF47" },
  { key: "woo", label: "WooCommerce", dot: "#96588a" },
  { key: "other", label: "Other", dot: "#8fb0c4" },
];
const pickCov = (r: CoverageRow, cms: CmsSel): PlatCoverage | null =>
  cms === "shopify" ? r.shopify : cms === "woo" ? r.woo : cms === "other" ? r.other : r.combined;

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Coverage" };

const SHOP = "#95BF47", WOO = "#96588a";

// A coverage cell: a small bar + the %, colour-coded per metric.
function Cov({ pct, tone }: { pct: number; tone: string }) {
  const c = tone === "mint" ? "bg-mint" : tone === "cyan" ? "bg-cyan" : "bg-lilac";
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="h-1.5 w-10 overflow-hidden rounded-full bg-cream/10">
        <div className={`h-full rounded-full ${c}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <span className="w-8 text-right text-xs tabular-nums text-cream/70">{pct}%</span>
    </div>
  );
}

// One store count per platform: tracked (bold) with discovered dimmed beneath.
function PlatCount({ p, color }: { p: PlatCoverage | null; color: string }) {
  if (!p || p.discovered === 0) return <span className="text-cream/20">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5" title={`${p.tracked.toLocaleString()} tracked · ${p.discovered.toLocaleString()} discovered`}>
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
      <span className="tabular-nums text-cream/85">{p.tracked.toLocaleString()}</span>
      {p.discovered !== p.tracked && <span className="tabular-nums text-[10px] text-cream/30">/{p.discovered.toLocaleString()}</span>}
    </span>
  );
}

const OTHER = "#8fb0c4";
const Dash = () => <span className="text-cream/20">—</span>;
function CountryRow({ r, cms }: { r: CoverageRow; cms: CmsSel }) {
  const cov = pickCov(r, cms);
  const has = cov && (cms === "all" ? cov.tracked > 0 : (cms === "shopify" ? r.shopify : cms === "woo" ? r.woo : r.other) != null);
  return (
    <tr className={`border-b border-cream/[0.06] ${r.focus ? "bg-cream/[0.03]" : ""}`}>
      <td className="py-2.5 pl-3 pr-2">
        <Link href={`/ops/coverage/${r.country}`} className="text-sm text-cream/85 hover:text-cyan hover:underline" title="See every CMS in this country">
          {countryEmoji(r.country)} {countryName(r.country)}
        </Link>
        {r.focus && <span className="ml-2 rounded-full border border-mint/25 bg-mint/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-mint">focus</span>}
      </td>
      <td className="py-2.5 pr-3 text-right text-sm"><PlatCount p={r.shopify} color={SHOP} /></td>
      <td className="py-2.5 pr-3 text-right text-sm"><PlatCount p={r.woo} color={WOO} /></td>
      <td className="py-2.5 pr-3 text-right text-sm"><PlatCount p={r.other} color={OTHER} /></td>
      <td className="py-2.5 pr-3 text-right text-sm tabular-nums" title="Unconfirmed candidates (platform not yet verified, unpublished) — the Woo worker probes these and publishes the real ones">
        {r.pending > 0 ? <span className="text-cream/40">{r.pending.toLocaleString()}</span> : <Dash />}
      </td>
      <td className="py-2.5 pr-3">{has ? <Cov pct={cov!.payPct} tone="mint" /> : <div className="text-right"><Dash /></div>}</td>
      <td className="py-2.5 pr-3">{has ? <Cov pct={cov!.launchPct} tone="cyan" /> : <div className="text-right"><Dash /></div>}</td>
      <td className="py-2.5 pr-3">{has ? <Cov pct={cov!.checkedPct} tone="lilac" /> : <div className="text-right"><Dash /></div>}</td>
    </tr>
  );
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

function GrandCard({ label, color, p }: { label: string; color: string; p: PlatCoverage }) {
  return (
    <div className="rounded-2xl border border-cream/12 bg-cream/[0.02] p-4">
      <div className="flex items-baseline gap-2">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
        <span className="text-sm font-semibold text-cream">{label}</span>
        <span className="ml-auto font-display text-2xl tabular-nums text-cream">{p.tracked.toLocaleString()}</span>
        <span className="text-[11px] text-cream/35">tracked</span>
      </div>
      <div className="mt-3 space-y-2">
        {([["Payments", p.payPct, "mint"], ["Launch date", p.launchPct, "cyan"], ["Liveness", p.checkedPct, "lilac"]] as const).map(([l, v, t]) => (
          <div key={l} className="flex items-center gap-2 text-[11px] text-cream/50">
            <span className="w-20">{l}</span>
            <Cov pct={v} tone={t} />
          </div>
        ))}
      </div>
    </div>
  );
}

export default async function CoveragePage({ searchParams }: { searchParams: Promise<{ cms?: string; from?: string; to?: string; ac?: string }> }) {
  const email = await currentUser();
  if (!email) redirect("/login");
  if (!isAdmin(email)) redirect("/dashboard");

  const sp = await searchParams;
  const cms: CmsSel = sp.cms === "shopify" || sp.cms === "woo" || sp.cms === "other" ? sp.cms : "all";
  // eslint-disable-next-line react-hooks/purity -- request-time date defaults in a dynamic server component
  const nowMs = Date.now();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(sp.from ?? "") ? sp.from! : iso(new Date(nowMs - 30 * 864e5));
  const to = /^\d{4}-\d{2}-\d{2}$/.test(sp.to ?? "") ? sp.to! : iso(new Date(nowMs));
  const ac = /^[A-Za-z]{2}$/.test(sp.ac ?? "") ? sp.ac!.toUpperCase() : "";

  const m = await coverageMatrix().catch(() => null);
  if (!m) return <main className="grid min-h-screen place-items-center text-cream/50">Couldn&rsquo;t load coverage.</main>;
  const activity = await rangeActivity(from, to, ac || undefined).catch(() => null);
  const cmsHref = (k: CmsSel) => { const p = new URLSearchParams(); if (k !== "all") p.set("cms", k); if (sp.from) p.set("from", sp.from); if (sp.to) p.set("to", sp.to); if (sp.ac) p.set("ac", sp.ac); const q = p.toString(); return q ? `?${q}` : "?"; };

  // Group rows by region, in REGION_ORDER; keep the focus-first / size ordering inside each.
  const byRegion = new Map<string, CoverageRow[]>();
  for (const r of m.rows) {
    const reg = regionOf(r.country);
    (byRegion.get(reg) ?? byRegion.set(reg, []).get(reg)!).push(r);
  }

  return (
    <main className="min-h-screen px-4 py-6">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-display text-2xl text-cream">Enrichment Coverage</h1>
            <p className="mt-1 text-xs text-cream/40">
              {m.discovered.toLocaleString()} discovered · {m.tracked.toLocaleString()} tracked · {m.pending.toLocaleString()} pending · {m.totalCountries} countries
            </p>
          </div>
          <Link href="/ops" className="rounded-full border border-cream/15 px-3 py-1 text-sm text-cream/60 hover:text-cream">← Ops</Link>
        </div>

        {/* Grand totals per platform */}
        <section className="mt-5 grid gap-3 sm:grid-cols-3">
          <GrandCard label="Shopify" color={SHOP} p={m.grand.shopify} />
          <GrandCard label="WooCommerce" color={WOO} p={m.grand.woo} />
          <GrandCard label="Other CMS" color={OTHER} p={m.grand.other} />
        </section>

        {/* What the numbers mean */}
        <section className="mt-4 rounded-2xl border border-cream/10 bg-cream/[0.02] p-4 text-[11px] leading-relaxed text-cream/55">
          <div className="mb-1.5 font-semibold uppercase tracking-wide text-cream/40">How to read this</div>
          <ul className="space-y-1">
            <li><b className="text-cream/80">Stores</b> — the bold number is <b className="text-cream/80">tracked</b> (published &amp; live — the set we present and enrich, and what Insights counts); the dim <span className="text-cream/40">/number</span> is everything <b className="text-cream/80">discovered</b> (incl. unpublished imports and stores we&rsquo;ve since confirmed dead or migrated off-platform).</li>
            <li><span className="text-mint">■</span> <b className="text-cream/80">Payments</b> — % of tracked stores with ≥1 payment gateway verified at checkout (Shopify checkout probe; Woo Store API / plugins).</li>
            <li><span className="text-cyan">■</span> <b className="text-cream/80">Launch date</b> — % with a real launch date on record (earliest product, StoreLeads launch, or first SSL cert).</li>
            <li><span className="text-lilac">■</span> <b className="text-cream/80">Liveness</b> — % with a liveness check on record (we&rsquo;ve confirmed alive/dead status at least once).</li>
            <li><b className="text-cream/80">Other</b> — every CMS that isn&rsquo;t Shopify or Woo (Wix, Squarespace, Magento, BigCommerce, Webflow, PrestaShop, Odoo, Ecwid…), rolled up. Captured but not yet surfaced in insights.</li>
            <li><b className="text-cream/80">Pending</b> — candidate domains we&rsquo;ve imported but not yet confirmed (platform unverified, unpublished). The Woo worker probes these and publishes the real ones, moving them into the Woo column.</li>
          </ul>
          <p className="mt-2 text-cream/40">Coverage % is over tracked stores. Focus markets (🇿🇦 🇰🇪 🇳🇬 🇯🇵) are actively enriched; the rest of the world is discovered &amp; banked but only lightly enriched. <b className="text-cream/70">Click any country</b> to see every CMS in it.</p>
        </section>

        {/* Activity by date range — pipeline + enrichment throughput in a window, per country */}
        <section id="activity" className="mt-6 rounded-3xl border border-cream/12 bg-cream/[0.02] p-4">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-cream/60">Activity by date range</h2>
            <span className="text-[11px] text-cream/35">{ac ? `${countryEmoji(ac)} ${countryName(ac)}` : "all countries"} · {from} → {to}</span>
          </div>
          <RangeFilter countries={m.rows.map((r) => ({ code: r.country, name: countryName(r.country), emoji: countryEmoji(r.country) })).sort((a, b) => a.name.localeCompare(b.name))} />
          {activity ? (
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {[
                { n: activity.discovered, l: "Discovered", s: "new · CT/DNS", c: "text-cyan" },
                { n: activity.imported, l: "Imported", s: "bulk import", c: "text-cream" },
                { n: activity.launched, l: "Launched", s: "real launch in range", c: "text-mint" },
                { n: activity.payments, l: "Payments enriched", s: "probed in range", c: "text-mint" },
                { n: activity.launchDated, l: "Launch dates", s: "catalog probed", c: "text-cyan" },
                { n: activity.liveness, l: "Liveness checks", s: "checked in range", c: "text-lilac" },
              ].map((x) => (
                <div key={x.l} className="rounded-2xl border border-cream/10 bg-cream/[0.02] p-3">
                  <div className={`font-display text-2xl leading-none ${x.c}`}>{x.n.toLocaleString()}</div>
                  <div className="mt-1 text-[11px] font-medium uppercase tracking-wide text-cream/45">{x.l}</div>
                  <div className="text-[10px] text-cream/30">{x.s}</div>
                </div>
              ))}
            </div>
          ) : <p className="mt-4 text-sm text-cream/40">Couldn&rsquo;t load activity.</p>}
          <p className="mt-3 text-[11px] leading-relaxed text-cream/35">
            <b className="text-cream/60">Discovered</b> = new stores found by our CT/DNS discovery in the window · <b className="text-cream/60">Imported</b> = added by a bulk import (StoreCensus / StoreLeads / BuiltWith) · <b className="text-cream/60">Launched</b> = stores whose <i>real launch date</i> lands in the window · the last three are enrichment probes that <i>ran</i> in the window.
          </p>
        </section>

        {/* CMS filter — controls the Payments / Launch / Liveness columns in the tables below */}
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-cream/40">Coverage by CMS:</span>
          {CMS_TABS.map((t) => (
            <Link key={t.key} href={cmsHref(t.key)} scroll={false}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition ${cms === t.key ? "bg-cream text-ink" : "border border-cream/15 text-cream/60 hover:text-cream"}`}>
              <span className="h-2 w-2 rounded-full" style={{ background: t.dot }} /> {t.label}
            </Link>
          ))}
          <span className="ml-1 text-[11px] text-cream/30">Payments · Launch · Liveness reflect the selected CMS</span>
        </div>

        {/* Region sections — collapsible */}
        {REGION_ORDER.filter((reg) => byRegion.has(reg)).map((reg) => {
          const rows = byRegion.get(reg)!;
          const tracked = rows.reduce((s, r) => s + r.tracked, 0);
          return (
            <details key={reg} open className="group mt-4 overflow-hidden rounded-2xl border border-cream/12 bg-cream/[0.02]">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 hover:bg-cream/[0.02]">
                <span className="flex items-center gap-2">
                  <span className="text-cream/40 transition group-open:rotate-90">▸</span>
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-cream/60">{reg}</h2>
                </span>
                <span className="text-[11px] text-cream/35">{rows.length} countries · {tracked.toLocaleString()} tracked</span>
              </summary>
              <div className="overflow-x-auto border-t border-cream/10">
                <table className="w-full min-w-[760px] border-collapse">
                  <thead>
                    <tr className="border-b border-cream/12 text-[10px] font-semibold uppercase tracking-wide text-cream/40">
                      <th className="py-2 pl-3 pr-2 text-left">Country</th>
                      <th className="py-2 pr-3 text-right">Shopify</th>
                      <th className="py-2 pr-3 text-right">Woo</th>
                      <th className="py-2 pr-3 text-right">Other</th>
                      <th className="py-2 pr-3 text-right">Pending</th>
                      <th className="py-2 pr-3 text-right">Payments</th>
                      <th className="py-2 pr-3 text-right">Launch</th>
                      <th className="py-2 pr-3 text-right">Liveness</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => <CountryRow key={r.country} r={r} cms={cms} />)}
                  </tbody>
                </table>
              </div>
            </details>
          );
        })}
      </div>
    </main>
  );
}
