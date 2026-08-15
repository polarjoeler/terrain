import { fetchInsights } from "@/lib/sheets";
import { InsightsView } from "./insights-view";

export const metadata = { title: "Terrain — Market Insights" };
// Reads the latest snapshot per request (the Sheet fetch is uncached).
export const dynamic = "force-dynamic";

export default async function Insights() {
  const { latest, history } = await fetchInsights();
  return (
    <InsightsView snapshot={latest} history={history} live={latest !== null} />
  );
}
