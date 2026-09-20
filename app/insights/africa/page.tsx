import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser, isAdmin } from "@/lib/auth";
import { getSubscriber, hasAccess } from "@/lib/subscriptions";
import { africaOverview, type PlatformSel } from "@/lib/insights";
import { cachedAgg } from "@/lib/agg-cache";
import { marketLabel } from "@/lib/markets";
import { AfricaMap } from "./africa-map";

export const metadata = { title: "Terrain — African eCommerce" };
export const dynamic = "force-dynamic";

const PLATFORMS: { key: PlatformSel; label: string; dot: string }[] = [
  { key: "all", label: "All", dot: "#8fb0c4" },
  { key: "shopify", label: "Shopify", dot: "#95BF47" },
  { key: "woocommerce", label: "WooCommerce", dot: "#96588a" },
];

export default async function AfricaOverview({
  searchParams,
}: {
  searchParams: Promise<{ platform?: string }>;
}) {
  const email = await currentUser();
  if (!email) redirect("/login");
  const subscriber = await getSubscriber(email).catch(() => null);
  if (!hasAccess(subscriber) && !isAdmin(email)) redirect("/billing");

  const sp = await searchParams;
  const platform: PlatformSel = sp.platform === "shopify" || sp.platform === "woocommerce" || sp.platform === "magento" ? sp.platform : "all";
  const data = await cachedAgg(`africa:${platform}`, 10 * 60 * 1000, () => africaOverview(platform)).catch(() => ({} as Record<string, { stores: number; launched30d: number }>));
  const ranked = Object.entries(data)
    .map(([iso2, s]) => ({ iso2, ...s }))
    .sort((a, b) => b.stores - a.stores);
  const totalStores = ranked.reduce((s, r) => s + r.stores, 0);
  const totalLaunched = ranked.reduce((s, r) => s + r.launched30d, 0);
  const pf = (p: PlatformSel) => `/insights/africa${p === "all" ? "" : `?platform=${p}`}`;

  return (
    <main className="min-h-screen px-4 py-6 md:px-8">
      <div className="mx-auto max-w-6xl">
        <nav className="flex items-center justify-between">
          <Link href="/insights" className="text-sm text-cream/60 hover:text-cream">← Insights</Link>
          <span className="rounded-full border border-mint/25 bg-mint/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-mint">Live data</span>
        </nav>

        <header className="mt-8">
          <h1 className="font-display text-4xl md:text-5xl">African eCommerce</h1>
          <p className="mt-2 max-w-2xl text-cream/60">
            Every store we track across the continent — {totalStores.toLocaleString()} live, {totalLaunched.toLocaleString()} launched in the last 30 days.
            Hover a country for the numbers, click to dive in.
          </p>
        </header>

        {/* platform filter (date + market filters come with the drill-in) */}
        <div className="mt-6 flex items-center gap-2 rounded-3xl border border-cream/12 bg-cream/[0.03] px-5 py-4">
          <span className="text-xs font-semibold uppercase tracking-wide text-cream/40">Platform</span>
          {PLATFORMS.map((p) => (
            <Link key={p.key} href={pf(p.key)}
              className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm transition ${platform === p.key ? "bg-cream text-ink" : "border border-cream/15 text-cream/60 hover:text-cream"}`}>
              <span className="h-2 w-2 rounded-full" style={{ background: p.dot }} /> {p.label}
            </Link>
          ))}
        </div>

        <div className="mt-6 grid gap-6 md:grid-cols-[1fr_18rem]">
          {/* the map */}
          <div className="rounded-[2rem] border border-cream/12 bg-cream/[0.02] p-4">
            <AfricaMap data={data} />
          </div>

          {/* ranked list — the drill-in shortcut */}
          <div className="rounded-[2rem] border border-cream/12 bg-cream/[0.02] p-4">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-cream/50">By store count</h2>
            {ranked.length === 0 ? (
              <p className="text-sm text-cream/40">No coverage yet.</p>
            ) : (
              <ul className="space-y-1">
                {ranked.slice(0, 15).map((r) => (
                  <li key={r.iso2}>
                    <Link href={`/insights?country=${r.iso2}`} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-cream/[0.05]">
                      <span className="truncate text-cream/85">{marketLabel(r.iso2)}</span>
                      <span className="flex shrink-0 items-baseline gap-2 tabular-nums">
                        <span className="text-cream/70">{r.stores.toLocaleString()}</span>
                        {r.launched30d > 0 && <span className="text-[11px] text-mint">+{r.launched30d}</span>}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-[11px] text-cream/35">Deep coverage in ZA / KE / NG today; the rest fills in as we widen enrichment.</p>
          </div>
        </div>
      </div>
    </main>
  );
}
