import {
  computeInsights,
  insightsHistory,
  snapshotInsights,
  getBaselineDate,
  availableCountries,
  cohortCount,
} from "@/lib/insights";
import { tagCounts } from "@/lib/tags";
import { providerMomentum, recentPaymentShifts } from "@/lib/provider-insights";
import { InsightsView } from "./insights-view";

export const metadata = { title: "Terrain — Market Insights" };
// Computed live from the store DB per request.
export const dynamic = "force-dynamic";

export default async function Insights({
  searchParams,
}: {
  searchParams: Promise<{ country?: string; tag?: string }>;
}) {
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

  const [data, baselineDate, momentum, shifts] = await Promise.all([
    computeInsights(country, tag),
    getBaselineDate(),
    providerMomentum("ALL", 30).catch(() => []),
    recentPaymentShifts(40).catch(() => []),
  ]);
  // Daily snapshots / trends are for the full ZA market only — not per-country
  // or per-cohort (the snapshot table is single-series).
  let history = [data];
  if (country === "ZA" && !tag) {
    await snapshotInsights(data).catch(() => {});
    const h = await insightsHistory().catch(() => [data]);
    if (h.length) history = h;
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
      momentum={momentum}
      shifts={shifts}
    />
  );
}
