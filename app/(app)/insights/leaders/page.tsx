import { redirect } from "next/navigation";
import { currentUser, isAdmin } from "@/lib/auth";
import { getSubscriber, hasAccess } from "@/lib/subscriptions";
import { leadersReport, leadersMarkets } from "@/lib/leaders-report";
import { marketLabel } from "@/lib/markets";
import { InsightsNav } from "../insights-nav";
import { LeadersControls } from "./leaders-controls";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Market leaders" };

const PLAT_LABEL: Record<string, string> = {
  custom: "Custom / headless", shopify: "Shopify", woocommerce: "WooCommerce", magento: "Magento",
  wix: "Wix", squarespace: "Squarespace", prestashop: "PrestaShop", bigcommerce: "BigCommerce",
  "salesforce commerce cloud": "Salesforce Commerce", "sap hybris": "SAP Hybris", odoo: "Odoo",
  wordpress: "WordPress", "x-cart": "X-Cart", "big cartel": "Big Cartel", shopware: "Shopware",
  "godaddy website builder": "GoDaddy", "drupal commerce": "Drupal Commerce", spree: "Spree",
  vtex: "VTEX", ecwid: "Ecwid", shopstar: "ShopStar", base: "BASE", cafe24: "Cafe24", unknown: "Unclassified",
};
const platLabel = (s: string) => PLAT_LABEL[s] ?? (s ? s.charAt(0).toUpperCase() + s.slice(1) : "Unclassified");
const usd = (n: number) => n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n)}`;
const barColor = (slug: string) => (slug === "custom" ? "var(--color-orange)" : slug === "shopify" ? "#95BF47" : slug === "woocommerce" ? "#96588a" : slug === "magento" ? "#f26322" : "var(--color-cyan)");

export default async function LeadersPage({ searchParams }: { searchParams: Promise<{ country?: string; cohort?: string }> }) {
  const email = await currentUser();
  if (!email) redirect("/login");
  const subscriber = await getSubscriber(email).catch(() => null);
  if (!hasAccess(subscriber) && !isAdmin(email)) redirect("/billing");

  const sp = await searchParams;
  const markets = await leadersMarkets().catch(() => []);
  const want = sp.country?.toUpperCase();
  const country = want && markets.some((m) => m.country === want) ? want : (markets[0]?.country ?? "ZA");
  const cohort = sp.cohort === "500" ? 500 : 100;
  const r = await leadersReport(country, cohort);

  const mkt = marketLabel(country);
  const platMax = Math.max(1, ...r.platforms.map((p) => p.stores));
  const revMax = Math.max(1, ...r.revenueByPlatform.map((p) => p.revenueUsd));
  const mi = r.mostInteresting;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <InsightsNav active="Markets" />
        <span className="shrink-0 rounded-full border border-mint/25 bg-mint/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-mint">Live data</span>
      </div>

      <header>
        <h1 className="font-display text-3xl font-bold tracking-tight text-cream md:text-4xl">Market leaders — {mkt}</h1>
        <p className="mt-2 max-w-2xl text-sm text-cream/60">
          The biggest stores in {mkt} and the platforms powering them. Leadership is ranked by <b className="text-cream/85">traffic</b> (so the custom/headless enterprise head shows up); revenue projections come from the <b className="text-cream/85">revenue-estimate cohort</b> we&rsquo;ve enriched.
        </p>
      </header>

      <LeadersControls markets={markets} country={country} cohort={cohort} />

      {/* ── PLATFORM LEADERSHIP (by traffic) ── */}
      <section className="rounded-[1.6rem] border border-cream/12 bg-cream/[0.03] p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold text-cream">Which platforms power the Top {r.cohort}</h2>
          <span className="text-xs text-cream/40">by traffic rank · {r.trafficTotal.toLocaleString()} stores</span>
        </div>
        {r.platforms.length ? (
          <div className="mt-5 space-y-2.5">
            {r.platforms.map((p) => (
              <div key={p.platform} className="flex items-center gap-3">
                <span className="w-36 shrink-0 truncate text-sm text-cream/85">{platLabel(p.platform)}</span>
                <span className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-cream/[0.06]">
                  <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.max(2, (p.stores / platMax) * 100)}%`, background: barColor(p.platform) }} />
                </span>
                <span className="w-14 shrink-0 text-right text-sm tabular-nums text-cream">{p.topPct}%</span>
                <span className="hidden w-28 shrink-0 text-right text-[11px] tabular-nums text-cream/40 sm:inline">
                  {p.stores} store{p.stores === 1 ? "" : "s"}{p.lift >= 1.5 ? ` · ${p.lift}× market` : ""}
                </span>
              </div>
            ))}
          </div>
        ) : <p className="mt-4 text-sm text-cream/40">No traffic-ranked stores in this market yet.</p>}
        {mi && (
          <div className="mt-5 flex flex-wrap items-center gap-2 rounded-2xl border border-orange/25 bg-orange/[0.06] px-4 py-3 text-sm text-cream/80">
            <span className="shrink-0 rounded-full bg-orange/20 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-orange">Most interesting</span>
            <span><b className="text-cream">{platLabel(mi.platform)}</b> powers <b className="text-cream">{mi.topPct}%</b> of {mkt}&rsquo;s Top {r.cohort} by traffic but only <b className="text-cream">{mi.overallPct}%</b> of all stores — <b className="text-cream">{mi.lift}×</b> over-represented among the leaders. {mi.platform === "custom" ? "The enterprise/headless head we uniquely surface — and the enrichment frontier." : ""}</span>
          </div>
        )}
      </section>

      {/* ── REVENUE LEADERS (by revenue estimate) ── */}
      <section className="rounded-[1.6rem] border border-cream/12 bg-cream/[0.03] p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold text-cream">Revenue projection — Top {r.cohort}</h2>
          <span className="text-xs text-cream/40">revenue-estimate cohort · {r.revenueStores.toLocaleString()} stores</span>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {[
            { n: usd(r.revenueMonthlyUsd), l: "projected / month" },
            { n: usd(r.revenueAnnualUsd), l: "projected / year" },
            { n: r.revenueStores ? usd(Math.round(r.revenueMonthlyUsd / r.revenueStores)) : "—", l: "avg / store / mo" },
          ].map((s) => (
            <div key={s.l} className="rounded-2xl border border-cream/10 bg-cream/[0.02] px-4 py-4">
              <div className="font-display text-3xl leading-none text-cream">{s.n}</div>
              <div className="mt-1.5 text-[11px] uppercase tracking-wide text-cream/45">{s.l}</div>
            </div>
          ))}
        </div>
        {r.revenueByPlatform.length > 0 && (
          <div className="mt-5 space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-cream/40">Where the revenue sits</div>
            {r.revenueByPlatform.filter((p) => p.revenueUsd > 0).map((p) => (
              <div key={p.platform} className="flex items-center gap-3">
                <span className="w-36 shrink-0 truncate text-sm text-cream/80">{platLabel(p.platform)}</span>
                <span className="relative h-2 flex-1 overflow-hidden rounded-full bg-cream/[0.06]">
                  <span className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-mint to-mint/45" style={{ width: `${Math.max(2, (p.revenueUsd / revMax) * 100)}%` }} />
                </span>
                <span className="w-16 shrink-0 text-right text-sm tabular-nums text-cream">{usd(p.revenueUsd)}</span>
                <span className="hidden w-16 shrink-0 text-right text-[11px] tabular-nums text-cream/40 sm:inline">{p.stores} st.</span>
              </div>
            ))}
          </div>
        )}
        <p className="mt-4 text-[11px] leading-relaxed text-cream/35">
          Projections sum <code className="text-cream/50">estimated_monthly_sales</code> (→ USD) across the enriched revenue-estimate cohort — Shopify-skewed, since that&rsquo;s where we hold revenue data. The custom/headless traffic head above mostly lacks estimates yet, so its true revenue is larger than shown here.
        </p>
      </section>

      {/* ── THE LEADERS (by traffic) ── */}
      <section className="rounded-[1.6rem] border border-cream/12 bg-cream/[0.03] p-6">
        <h2 className="text-lg font-semibold text-cream">The Top {Math.min(15, r.topStores.length)} by traffic</h2>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[460px] text-left text-sm">
            <thead className="text-[11px] uppercase tracking-wide text-cream/40">
              <tr><th className="pb-2 pr-3">#</th><th className="pb-2 pr-3">Store</th><th className="pb-2 pr-3">Platform</th><th className="pb-2 text-right">Traffic rank</th></tr>
            </thead>
            <tbody>
              {r.topStores.map((s, i) => (
                <tr key={s.domain} className="border-t border-cream/10">
                  <td className="py-2 pr-3 tabular-nums text-cream/40">{i + 1}</td>
                  <td className="py-2 pr-3">
                    <a href={`https://${s.domain}`} target="_blank" rel="noopener noreferrer" className="font-medium text-cream hover:underline">{s.name ?? s.domain}</a>
                    <div className="font-mono text-[11px] text-cream/35">{s.domain}</div>
                  </td>
                  <td className="py-2 pr-3 text-cream/70">{platLabel((s.platform ?? "unknown").toLowerCase())}</td>
                  <td className="py-2 text-right tabular-nums text-cream/55">{s.cruxRank != null ? `#${s.cruxRank.toLocaleString()}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
