import { redirect, notFound } from "next/navigation";
import { currentUser, isAdmin } from "@/lib/auth";
import { getSubscriber, hasAccess } from "@/lib/subscriptions";
import { sectionReport, isReportSection, availableCountries, type PeriodKey } from "@/lib/insights";
import { cachedAgg } from "@/lib/agg-cache";
import { ReportView } from "./report-view";

export const dynamic = "force-dynamic";
const PERIODS: PeriodKey[] = ["day", "week", "month", "quarter", "year"];

export async function generateMetadata({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  return { title: `Terrain — ${section} report` };
}

export default async function SectionReportPage({
  params, searchParams,
}: {
  params: Promise<{ section: string }>;
  searchParams: Promise<{ country?: string; period?: string; back?: string; platform?: string }>;
}) {
  const { section } = await params;
  if (!isReportSection(section)) notFound();

  // Same paywall as /insights — proprietary data, subscribers (or owner) only.
  const email = await currentUser();
  if (!email) redirect("/login");
  const subscriber = await getSubscriber(email).catch(() => null);
  if (!hasAccess(subscriber) && !isAdmin(email)) redirect("/billing");

  const sp = await searchParams;
  // Both reads are viewer-agnostic (same for every subscriber), so serve them from the shared
  // persistent aggregate cache — the same thing that makes /insights/africa|japan and /ops fast.
  // Without it every request recomputed live on the (occasionally slow) pooler, which is the
  // "loads forever, no idea how long" symptom. Country list changes rarely → 30 min; the section
  // report → 15 min (its provider_snapshots source only updates ~weekly, so this is plenty fresh).
  const countries = await cachedAgg("insights:countries:v1", 12 * 60 * 60 * 1000, availableCountries)
    .catch(() => [] as { country: string; stores: number }[]);
  const country = sp.country && countries.some((c) => c.country === sp.country) ? sp.country : "ZA";
  const period = (PERIODS.includes(sp.period as PeriodKey) ? sp.period : "week") as PeriodKey;
  const back = Math.max(0, Math.min(36, parseInt(sp.back ?? "0", 10) || 0)); // periods back (0 = now)
  // Payments can be viewed combined ('all', default) or drilled into one CMS in that country.
  const PLATFORMS = ["all", "shopify", "woocommerce", "magento"];
  const platform = PLATFORMS.includes(sp.platform ?? "") ? (sp.platform as string) : "all";

  const report = await cachedAgg(
    `insights:report:${section}:${country}:${period}:${back}:${platform}:v1`,
    2 * 60 * 60 * 1000, // 2h — snapshots update ~weekly, and SWR refreshes in the background anyway
    () => sectionReport(section, country, period, back, platform),
  ).catch(() => null);
  if (!report) notFound();

  return <ReportView report={report} country={country} countries={countries.map((c) => c.country)} platform={platform} />;
}
