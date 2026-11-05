import { NextResponse } from "next/server";
import { cachedAgg } from "@/lib/agg-cache";
import {
  availableProviders, providerInsights, providerHistory, providerLaunchShare, providerSubReport,
  providerSwitches, providerNewShareSeries, type NewSharePeriod, type NewShareBucket,
} from "@/lib/provider-insights";
import { providerAdoptionSeries, type AdoptionGranularity } from "@/lib/insights";
import { declaredMarkets } from "@/lib/provider-markets";
import { VISIBLE_MARKETS } from "@/lib/markets";

// Warms the agg_cache entries behind the provider "Intelligence" pages (/p/[provider]) and the
// payment-adoption charts (/api/provider-adoption), so the first viewer — e.g. a PSP we've shared a
// report with — hits the fast cached path instead of triggering the heavy ~9-query bundle inline.
// Token-gated like the other cron warmers. Params: ?providers=a,b (slugs/names; default top N by
// volume), ?limit=N, ?markets=ZA,KE,MU (adoption markets; default VISIBLE_MARKETS).
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PERIODS: NewSharePeriod[] = ["day", "week", "month", "quarter", "year"];
const GRAINS: AdoptionGranularity[] = ["year", "quarter", "month"];

// MIRRORS app/p/[provider]/page.tsx — identical cache key + bundle shape, so a warmed row is exactly
// the one the page reads. Keep in sync with that file if the bundle changes.
async function warmProvider(canonical: string, country: string | undefined, platform = "all") {
  const declared = declaredMarkets(canonical);
  const scopeMarkets = country ? undefined : declared.length ? declared : undefined;
  await cachedAgg(
    `provider:${canonical}:${country ?? "ALL"}:${platform}:v2`,
    10 * 60 * 1000,
    async () => {
      const [data, history, launchShare, subReport, switches] = await Promise.all([
        providerInsights(canonical, country, platform),
        providerHistory(canonical, country ?? "ALL", platform),
        providerLaunchShare(canonical, country, platform, scopeMarkets),
        providerSubReport(canonical, country, platform),
        providerSwitches(canonical, country, 12, platform),
      ]);
      const series = await Promise.all(PERIODS.map((pr) => providerNewShareSeries(canonical, pr, country, platform, scopeMarkets).catch(() => [])));
      const newShare = Object.fromEntries(PERIODS.map((pr, i) => [pr, series[i]])) as Record<NewSharePeriod, NewShareBucket[]>;
      return { data, history, launchShare, subReport, switches, newShare };
    },
  );
}

// MIRRORS app/api/provider-adoption/route.ts — identical key.
async function warmAdoption(country: string, grain: AdoptionGranularity, platform = "all") {
  await cachedAgg(
    `insights:adoption:${country}:${platform}:${grain}:v4`,
    6 * 60 * 60 * 1000,
    () => providerAdoptionSeries(country, platform, grain),
  );
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const url = new URL(req.url);
  if (secret) {
    const token = url.searchParams.get("token");
    if (req.headers.get("authorization") !== `Bearer ${secret}` && token !== secret) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
  }
  const t = Date.now();

  // Resolve which providers to warm. Explicit ?providers= takes slugs or names; default = top N.
  const all = await availableProviders(5).catch(() => []);
  const paramProv = url.searchParams.get("providers");
  const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit") ?? 8)));
  let provs: string[];
  if (paramProv) {
    const wanted = paramProv.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "-");
    provs = all.map((x) => x.provider).filter((p) => wanted.some((w) => p.toLowerCase() === w || norm(p) === w));
  } else {
    provs = all.slice(0, limit).map((x) => x.provider);
  }

  let warmed = 0;
  const detail: string[] = [];
  for (const canonical of provs) {
    try {
      await warmProvider(canonical, undefined); // "All markets" view
      warmed++;
      for (const m of declaredMarkets(canonical)) { await warmProvider(canonical, m); warmed++; }
      detail.push(canonical);
    } catch { /* keep warming the rest */ }
  }

  const markets = url.searchParams.get("markets")?.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) ?? [...VISIBLE_MARKETS];
  let adoptionWarmed = 0;
  for (const c of markets) for (const g of GRAINS) { try { await warmAdoption(c, g); adoptionWarmed++; } catch { /* skip */ } }

  return NextResponse.json({ ok: true, providersWarmed: warmed, providers: detail, adoptionWarmed, markets, ms: Date.now() - t });
}
