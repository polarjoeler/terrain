import { redirect, notFound } from "next/navigation";
import { currentUser, isAdmin } from "@/lib/auth";
import { getSubscriber, hasAccess } from "@/lib/subscriptions";
import { sectionReport, isReportSection, availableCountries, type PeriodKey } from "@/lib/insights";
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
  searchParams: Promise<{ country?: string; period?: string }>;
}) {
  const { section } = await params;
  if (!isReportSection(section)) notFound();

  // Same paywall as /insights — proprietary data, subscribers (or owner) only.
  const email = await currentUser();
  if (!email) redirect("/login");
  const subscriber = await getSubscriber(email).catch(() => null);
  if (!hasAccess(subscriber) && !isAdmin(email)) redirect("/billing");

  const sp = await searchParams;
  const countries = await availableCountries().catch(() => [] as { country: string; stores: number }[]);
  const country = sp.country && countries.some((c) => c.country === sp.country) ? sp.country : "ZA";
  const period = (PERIODS.includes(sp.period as PeriodKey) ? sp.period : "week") as PeriodKey;

  const report = await sectionReport(section, country, period).catch(() => null);
  if (!report) notFound();

  return <ReportView report={report} country={country} countries={countries.map((c) => c.country)} />;
}
