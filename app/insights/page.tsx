import { fetchInsights } from "@/lib/sheets";
import { InsightsView } from "./insights-view";

export const metadata = { title: "Terrain — Market Insights" };
// Refresh at most every 30 minutes.
export const revalidate = 1800;

export default async function Insights() {
  const { latest, history } = await fetchInsights();
  return (
    <InsightsView snapshot={latest} history={history} live={latest !== null} />
  );
}
