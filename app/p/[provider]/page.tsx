import { notFound } from "next/navigation";
import { currentUser, isAdmin } from "@/lib/auth";
import { providerInsights, providerHistory, availableProviders } from "@/lib/provider-insights";
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
  searchParams: Promise<{ t?: string }>;
}) {
  const { provider } = await params;
  const { t } = await searchParams;

  // Resolve the canonical gateway name (proper casing) from the data.
  const providers = await availableProviders(1).catch(() => []);
  const canonical = providers.find((x) => x.provider.toLowerCase() === provider.toLowerCase())?.provider;
  if (!canonical) notFound();

  // Access: an admin (logged in) OR a valid signed share token for THIS provider.
  const admin = isAdmin(await currentUser());
  if (!admin && !verifyProviderToken(canonical, t)) notFound();

  const [data, history] = await Promise.all([providerInsights(canonical), providerHistory(canonical)]);
  // Admins see the shareable link; a token viewer already has theirs.
  const shareToken = admin ? signProviderToken(canonical) : (t ?? "");

  return <ProviderView data={data} history={history} shareToken={shareToken} isAdmin={admin} />;
}
