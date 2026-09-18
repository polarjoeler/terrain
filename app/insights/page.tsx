import {
  cachedInsights,
  insightsHistory,
  snapshotInsights,
  getBaselineDate,
  availableCountries,
  cohortCount,
  type PlatformSel,
} from "@/lib/insights";
import { tagCounts } from "@/lib/tags";
import { providerMomentum, recentPaymentShifts } from "@/lib/provider-insights";
import { InsightsView } from "./insights-view";
import { redirect } from "next/navigation";
import { currentUser, isAdmin } from "@/lib/auth";
import { getSubscriber, hasAccess } from "@/lib/subscriptions";

export const metadata = { title: "Terrain — Market Insights" };
// Computed live from the store DB per request.
export const dynamic = "force-dynamic";

export default async function Insights({
  searchParams,
}: {
  searchParams: Promise<{ country?: string; tag?: string; platform?: string }>;
}) {
  // Paywall: proprietary market data — signed-in paid subscribers (or the owner) only.
  const email = await currentUser();
  if (!email) redirect("/login");
  const subscriber = await getSubscriber(email).catch(() => null);
  if (!hasAccess(subscriber) && !isAdmin(email)) redirect("/billing");

  const sp = await searchParams;
  const [countries, tags] = await Promise.all([
    availableCountries().catch(() => []),
    tagCounts().catch(() => []),
  ]);
  const country =
    sp.country && countries.some((c) => c.country === sp.country) ? sp.country : "ZA";
  // Dynamic "Brand New Stores" cohort (recently discovered in this market),
  // shown first, then the curated tag cohorts.
  const newCount = await cohortCount(country, "new").catch(() => 0);
  const cohorts = [{ tag: "new", count: newCount }, ...tags];
  // Only accept a cohort that actually has stores.
  const tag = sp.tag && cohorts.some((c) => c.tag === sp.tag && c.count > 0) ? sp.tag : undefined;
  // Default view is "all" — a combined Woo + Shopify (+ future platforms) growth picture per
  // market, as the landing state. The Shopify / WooCommerce tabs then drill into one platform.
  const platform: PlatformSel = sp.platform === "woocommerce" || sp.platform === "shopify" ? sp.platform : "all";

  const [data, baselineDate, momentum, shifts] = await Promise.all([
    cachedInsights(country, tag, platform),
    getBaselineDate(),
    // Scope momentum to the SAME market as the rest of the page. Discovery-neutral,
    // week-over-week among newly-discovered stores (not snapshot counts, which the
    // payment backfill inflated).
    providerMomentum(country, "week").catch(() => []),
    // Recent switches scoped to the selected market (falls back to the core African markets
    // ZA/KE/NG if somehow no single market resolves) — a global feed drowned the local signal.
    recentPaymentShifts(40, country ? [country] : ["ZA", "KE", "NG"]).catch(() => []),
  ]);
  // Daily snapshots / trends are a single Shopify-only ZA series (the snapshot table is
  // single-series): a WooCommerce/all page view once overwrote it with Woo data (storesTotal
  // 679, plus 0), a fake Plus-trend drop. So we ALWAYS snapshot the Shopify computation on the
  // ZA no-tag view — computing it explicitly when the view itself is all/Woo — and only hydrate
  // comparison history for the matching Shopify view (all/Woo show live figures without period
  // deltas, since a cross-platform delta vs a Shopify baseline would be apples-to-oranges).
  let history = [data];
  if (country === "ZA" && !tag) {
    const snapData = platform === "shopify" ? data : await cachedInsights(country, undefined, "shopify").catch(() => null);
    if (snapData) await snapshotInsights(snapData).catch(() => {});
    if (platform === "shopify") {
      const h = await insightsHistory().catch(() => [data]);
      if (h.length) history = h;
    }
  }

  return (
    <InsightsView
      data={data}
      history={history}
      baselineDate={baselineDate}
      countries={countries}
      country={country}
      cohorts={cohorts}
      tag={tag ?? ""}
      platform={platform}
      momentum={momentum}
      shifts={shifts}
    />
  );
}
