import { existsSync } from "node:fs";
import path from "node:path";
import { notFound } from "next/navigation";
import { currentUser, isAdmin } from "@/lib/auth";
import { getSubscriber, hasAccess } from "@/lib/subscriptions";
import { providerInsights, providerHistory, availableProviders, providerCountries, providerNewShareSeries, type NewSharePeriod, type NewShareBucket } from "@/lib/provider-insights";
import { signProviderToken, verifyProviderToken } from "@/lib/provider-share";
import { matchesProviderSlug, providerSlug, slugToTitle } from "@/lib/provider-slug";
import { ProviderView } from "./provider-view";

export const dynamic = "force-dynamic";

/** A provider's logo is just a file named after its slug in public/providers —
 *  drop one in and the page uses it, with no code change (see the README there).
 *  Falls back to the provider's name as text, which is the default for everyone. */
const LOGO_EXTS = ["svg", "png", "webp"];
function providerLogo(slug: string): string | null {
  for (const ext of LOGO_EXTS) {
    const rel = `/providers/${slug}.${ext}`;
    if (existsSync(path.join(process.cwd(), "public", rel))) return rel;
  }
  return null;
}

export async function generateMetadata({ params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const name = slugToTitle(provider);
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

  // Resolve the canonical gateway name (proper casing) from the data. Matching is
  // slug-based so multi-word gateways work as clean paths — "Peach Payments" is
  // reachable at /p/peach-payments, not just /p/peach%20payments.
  const providers = await availableProviders(1).catch(() => []);
  const canonical = providers.find((x) => matchesProviderSlug(x.provider, provider))?.provider;
  if (!canonical) notFound();

  // Access: admin, OR a signed-in paid subscriber, OR a valid signed share token for
  // THIS provider (so a report can still be shared with a PSP who isn't a subscriber).
  const email = await currentUser();
  const admin = isAdmin(email);
  const paid = email ? hasAccess(await getSubscriber(email).catch(() => null)) : false;
  if (!admin && !paid && !verifyProviderToken(canonical, t)) notFound();

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

  // Slug is [a-z0-9-] only, so it's safe to build a path from.
  const logo = providerLogo(providerSlug(canonical));

  return <ProviderView data={data} history={history} newShare={newShare} shareToken={shareToken} isAdmin={admin}
    countries={countries} country={country ?? ""} logo={logo} />;
}
