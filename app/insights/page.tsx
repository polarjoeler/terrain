import {
  computeInsights,
  insightsHistory,
  snapshotInsights,
  getBaselineDate,
  availableCountries,
} from "@/lib/insights";
import { tagCounts } from "@/lib/tags";
import { InsightsView } from "./insights-view";

export const metadata = { title: "Terrain — Market Insights" };
// Computed live from the store DB per request.
export const dynamic = "force-dynamic";

export default async function Insights({
  searchParams,
}: {
  searchParams: Promise<{ country?: string; tag?: string }>;
}) {
  const [countries, cohorts] = await Promise.all([
    availableCountries().catch(() => []),
    tagCounts().catch(() => []),
  ]);
  const sp = await searchParams;
  const country =
    sp.country && countries.some((c) => c.country === sp.country) ? sp.country : "ZA";
  // Only accept a cohort tag that actually has stores.
  const tag = sp.tag && cohorts.some((c) => c.tag === sp.tag && c.count > 0) ? sp.tag : undefined;

  const [data, baselineDate] = await Promise.all([computeInsights(country, tag), getBaselineDate()]);
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
    />
  );
}
