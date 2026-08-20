import {
  computeInsights,
  insightsHistory,
  snapshotInsights,
  getBaselineDate,
  availableCountries,
} from "@/lib/insights";
import { InsightsView } from "./insights-view";

export const metadata = { title: "Terrain — Market Insights" };
// Computed live from the store DB per request.
export const dynamic = "force-dynamic";

export default async function Insights({
  searchParams,
}: {
  searchParams: Promise<{ country?: string }>;
}) {
  const countries = await availableCountries().catch(() => []);
  const sp = await searchParams;
  // Default to the biggest market (ZA), and only accept a country we actually have.
  const country =
    sp.country && countries.some((c) => c.country === sp.country) ? sp.country : "ZA";

  const [data, baselineDate] = await Promise.all([computeInsights(country), getBaselineDate()]);
  // Daily snapshots (and thus the over-time trends) are ZA-only for now — the
  // snapshot table is single-series; per-country history builds once seeded.
  let history = [data];
  if (country === "ZA") {
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
    />
  );
}
