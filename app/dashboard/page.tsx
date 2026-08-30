import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { Wordmark } from "@/app/components/logo";
import { currentUser } from "@/lib/auth";
import { sampleLeads } from "@/lib/leads";
import { summarise } from "@/lib/sheets";
import { getHomeStats, availableCountries } from "@/lib/insights";
import { MarketPicker } from "./market-picker";
import { FreshnessStamp } from "@/app/components/freshness";
import { getSubscriber, hasAccess, trialDaysLeft } from "@/lib/subscriptions";
import { exploreBrowse } from "@/lib/leads-explore";
import { Explorer } from "@/app/admin/explore/explorer";

// Per-user paywall — never cache this page across requests.
export const dynamic = "force-dynamic";

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{
    country?: string; q?: string; payment?: string; shipping?: string;
    theme?: string; city?: string; category?: string; band?: string;
  }>;
}) {
  const email = await currentUser();
  if (!email) redirect("/login");

  const subscriber = await getSubscriber(email);
  if (!hasAccess(subscriber)) redirect("/billing");

  const daysLeft = trialDaysLeft(subscriber);

  // Market filter (default South Africa) — the tiles + table both respect it.
  const markets = await availableCountries().catch(() => [] as { country: string; stores: number }[]);
  const sp = await searchParams;
  const country = sp.country && markets.some((m) => m.country === sp.country) ? sp.country : "ZA";

  // Drill-through: insights links land here with a facet pre-applied
  // (e.g. /dashboard?payment=Paystack) — seed the Explorer's filters from them.
  const csv = (v?: string) => (v ? v.split(",").map((x) => x.trim()).filter(Boolean) : undefined);
  const drill = {
    q: sp.q,
    country: sp.country ? [sp.country] : undefined,
    payment: csv(sp.payment), shipping: csv(sp.shipping), theme: csv(sp.theme),
    city: csv(sp.city), category: csv(sp.category), band: csv(sp.band),
  };

  // Tile numbers all come from the single getHomeStats() aggregate (one indexed
  // COUNT query) — same source as /insights and the homepage, so the counts agree.
  // Previously we also loaded EVERY lead just to count emails; getHomeStats already
  // computes that count, so we dropped the full-table load (it was the tiles' main
  // latency). Fall back to bundled samples only if the DB is unreachable.
  let live: boolean;
  let updatedAt: string | null;
  let stats: { storesTracked: number; newThisWeek: number; plusFlagged: number; withEmail: number };
  try {
    const home = await getHomeStats(country);
    if (!home.live) throw new Error("no live stores");
    live = true;
    updatedAt = home.updatedAt;
    stats = {
      storesTracked: home.storesTracked,
      newThisWeek: home.newThisWeek,
      plusFlagged: home.plusFlagged,
      withEmail: home.withEmail ?? 0,
    };
  } catch {
    live = false;
    updatedAt = null;
    const s = summarise(sampleLeads);
    stats = { storesTracked: s.storesTracked, newThisWeek: s.newThisWeek, plusFlagged: s.plusFlagged, withEmail: s.withEmail };
  }

  return (
    <div className="min-h-screen px-4 py-6 md:px-8">
      <div className="mx-auto max-w-6xl">
        <nav className="flex flex-wrap items-center justify-between gap-3">
          <Link href="/" className="min-w-0 shrink">
            <Wordmark size="text-xl sm:text-2xl" tone="cream" />
          </Link>
          <div className="flex flex-wrap items-center justify-end gap-2 text-sm">
            {daysLeft !== null && (
              <Link
                href="/billing"
                className="whitespace-nowrap rounded-full bg-mint px-4 py-1.5 font-medium text-ink transition hover:brightness-95"
              >
                {daysLeft} day{daysLeft === 1 ? "" : "s"} left · subscribe
              </Link>
            )}
            {subscriber?.status === "past_due" && (
              <Link
                href="/billing"
                className="rounded-full bg-orange px-4 py-1.5 font-medium text-cream"
              >
                Payment failed — update card
              </Link>
            )}
            <MarketPicker countries={markets} country={country} />
            <Link
              href="/insights"
              className="whitespace-nowrap rounded-full border border-cream/20 px-4 py-1.5 text-cream/70 transition hover:border-cream/50 hover:text-cream"
            >
              Insights →
            </Link>
            <span className="hidden whitespace-nowrap rounded-full border border-cream/20 px-4 py-1.5 text-cream/70 sm:inline">
              {live ? (
                <>
                  <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-mint align-middle" />
                  Live feed · {stats.newThisWeek} new this week
                </>
              ) : (
                "Sample data"
              )}
            </span>
            <form action="/api/auth/signout" method="post">
              <button
                type="submit"
                title={email}
                className="grid h-9 w-9 place-items-center rounded-full bg-orange font-medium uppercase"
              >
                {email[0]}
              </button>
            </form>
          </div>
        </nav>

        <header className="mt-10">
          <h1 className="font-display text-4xl md:text-5xl">
            Welcome back
          </h1>
          <p className="mt-2 text-cream/60">
            Signed in as {email} · fresh South African Shopify stores,
            discovered as they launch.
          </p>
          <div className="mt-3">
            <FreshnessStamp updatedAt={updatedAt} live={live} />
          </div>
        </header>

        <div className="mt-8 grid gap-4 md:grid-cols-4">
          <div className="rounded-3xl bg-mint p-5 text-ink">
            <div className="font-display text-4xl">+{stats.newThisWeek}</div>
            <div className="mt-1 text-xs font-semibold uppercase tracking-wide opacity-70">
              New this week
            </div>
          </div>
          <div className="rounded-3xl bg-lilac p-5 text-ink">
            <div className="font-display text-4xl">{stats.plusFlagged}</div>
            <div className="mt-1 text-xs font-semibold uppercase tracking-wide opacity-70">
              Shopify Plus
            </div>
          </div>
          <div className="rounded-3xl border border-cream/15 p-5">
            <div className="font-display text-4xl">{stats.withEmail}</div>
            <div className="mt-1 text-xs font-semibold uppercase tracking-wide text-cream/50">
              With direct email
            </div>
          </div>
          <div className="rounded-3xl border border-cream/15 p-5">
            <div className="font-display text-4xl">{stats.storesTracked.toLocaleString()}</div>
            <div className="mt-1 text-xs font-semibold uppercase tracking-wide text-cream/50">
              Stores tracked
            </div>
          </div>
        </div>
      </div>

      {/* Browse gets a WIDER centered container than the hero — the leads table has
          a filter rail + many columns and looked cramped/cut-off inside max-w-6xl.
          Both are centered, so the page stays balanced. */}
      <div className="mx-auto mt-10 max-w-[1600px]">
        <div className="mb-3 flex items-baseline justify-between px-1">
          <h2 className="font-display text-2xl">Browse stores</h2>
          <span className="text-xs text-cream/40">
            {live ? "Live · refreshed every 10 minutes" : "Sample data — live feed unavailable"}
          </span>
        </div>
        {/* Streamed so the shell + tiles paint instantly — the full live set is a
            heavy load (~13k rich rows), and we don't want it blocking first paint. */}
        <Suspense fallback={<BrowseSkeleton />}>
          <BrowseSection initial={drill} />
        </Suspense>
      </div>
    </div>
  );
}

// Loads the ENTIRE live set (not a top-N slice) so every lead — and its
// enrichment — is browsable. Runs inside Suspense, off the page's critical path.
async function BrowseSection({ initial }: { initial?: import("@/app/admin/explore/explorer").ExploreInitial }) {
  const { leads, count } = await exploreBrowse().catch(() => ({ leads: [], count: 0 }));
  if (!leads.length) return <p className="py-10 text-center text-cream/40">No stores to browse yet.</p>;
  return <Explorer leads={leads} total={count} initial={initial} />;
}

function BrowseSkeleton() {
  return (
    <div className="animate-pulse">
      <div className="flex gap-4">
        <div className="hidden h-96 w-48 shrink-0 rounded-2xl bg-cream/[0.04] md:block" />
        <div className="flex-1 space-y-2">
          <div className="h-10 rounded-xl bg-cream/[0.05]" />
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-12 rounded-lg bg-cream/[0.03]" />
          ))}
        </div>
      </div>
      <p className="mt-4 text-center text-xs text-cream/30">Loading all live stores…</p>
    </div>
  );
}
