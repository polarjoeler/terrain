import { cookies } from "next/headers";
import { cachedAgg } from "@/lib/agg-cache";
import { japanTimeline, type JapanTimeline, JP_REGIONS } from "@/lib/japan-timeline";
import { JapanHome } from "@/app/insights/japan/japan-home";
import type { Lang } from "@/app/insights/japan/japan-replay";

// PUBLIC, shareable Japan homepage — full parity with the Africa homepage (products, segments,
// newsletter) but Japan-tuned and bilingual. No login gate (unlike /insights/japan). This is also
// where the geo middleware sends visitors it places in Japan.
export const metadata = {
  title: "Japanese eCommerce — Terrain",
  description: "Watch a decade of Japanese online-store growth replay across the eight regions in thirty seconds. Market intelligence for Japanese commerce, from Terrain.",
  openGraph: {
    title: "Japanese eCommerce — Terrain",
    description: "A decade of Japanese online-store growth, replayed across the map in thirty seconds.",
  },
};
export const dynamic = "force-dynamic"; // reads the geo cookie; cachedAgg still memoizes the heavy query

const EMPTY: JapanTimeline = {
  months: [], regions: Object.fromEntries(JP_REGIONS.map((r) => [r, { shopify: [] as number[], woo: [] as number[], rest: [] as number[] }])) as unknown as JapanTimeline["regions"],
  pulses: [], featured: [], ops: { scanned24h: 0, disc7d: 0, discToday: 0, recent: [] },
  meta: { lastLaunch: null, lastRefresh: null, totalTracked: 0, located: 0 },
};

export default async function JapanPublicHome() {
  const data = await cachedAgg("japan:timeline:v1", 30 * 60 * 1000, japanTimeline).catch(() => EMPTY);
  // A visitor the geo middleware routed here from Japan carries geo=jp — greet them in Japanese.
  // Anyone reaching the shared link directly (no cookie) gets English, with the toggle one tap away.
  const geo = (await cookies()).get("geo")?.value;
  const initialLang: Lang = geo === "jp" ? "ja" : "en";

  return <JapanHome data={data} initialLang={initialLang} />;
}
