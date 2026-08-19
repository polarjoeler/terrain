import { computeInsights, insightsHistory, snapshotInsights, getBaselineDate } from "@/lib/insights";
import { InsightsView } from "./insights-view";

export const metadata = { title: "Terrain — Market Insights" };
// Computed live from the store DB per request.
export const dynamic = "force-dynamic";

export default async function Insights() {
  const [data, baselineDate] = await Promise.all([computeInsights(), getBaselineDate()]);
  // Persist today's snapshot (idempotent per day) so the over-time trends build up.
  await snapshotInsights(data).catch(() => {});
  const history = await insightsHistory().catch(() => [data]);
  return (
    <InsightsView
      data={data}
      history={history.length ? history : [data]}
      baselineDate={baselineDate}
    />
  );
}
