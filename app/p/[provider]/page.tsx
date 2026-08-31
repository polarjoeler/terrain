import { notFound } from "next/navigation";
import { currentUser, isAdmin } from "@/lib/auth";
import { providerInsights, providerHistory, availableProviders, providerCountries, providerNewShareSeries, type NewSharePeriod, type NewShareBucket } from "@/lib/provider-insights";
import { signProviderToken, verifyProviderToken } from "@/lib/provider-share";
import { ProviderView } from "./provider-view";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const name = provider.charAt(0).toUpperCase() + provider.slice(1);
  return { title: `${name} — Market Insights` };
}

export default async function ProviderPage({
  params, searchParams,
}: {
  params: Promise<{ provider: string }>;
  searchParams: Promise<{ t?: string; country?: string }>;
}) {
  const { provider } = await params;
  const { t, country: countryParam } = await searchParams;

  // Resolve the canonical gateway name (proper casing) from the data.
  const providers = await availableProviders(1).catch(() => []);
  const canonical = providers.find((x) => x.provider.toLowerCase() === provider.toLowerCase())?.provider;
  if (!canonical) notFound();

  // Access: an admin (logged in) OR a valid signed share token for THIS provider.
  const admin = isAdmin(await currentUser());
  if (!admin && !verifyProviderToken(canonical, t)) notFound();

  // Country filter (from the dropdown). Validate against the countries we actually have.
  const countries = await providerCountries(canonical).catch((): string[] => []);
  const country = countryParam && countries.includes(countryParam.toUpperCase()) ? countryParam.toUpperCase() : undefined;

  const [data, history] = await Promise.all([
    providerInsights(canonical, country),
    providerHistory(canonical, country ?? "ALL"),
  ]);
  // Share-of-new-stores series at each granularity, so the chart's Day/Week/Month/
  // Quarter/Year toggle is instant (no re-fetch).
  const periods: NewSharePeriod[] = ["day", "week", "month", "quarter", "year"];
  const series = await Promise.all(periods.map((pr) => providerNewShareSeries(canonical, pr, country).catch(() => [])));
  const newShare = Object.fromEntries(periods.map((pr, i) => [pr, series[i]])) as Record<NewSharePeriod, NewShareBucket[]>;

  // Admins see the shareable link; a token viewer already has theirs.
  const shareToken = admin ? signProviderToken(canonical) : (t ?? "");

  return <ProviderView data={data} history={history} newShare={newShare} shareToken={shareToken} isAdmin={admin}
    countries={countries} country={country ?? ""} />;
}
