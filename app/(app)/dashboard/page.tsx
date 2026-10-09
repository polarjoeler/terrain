import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getHomeStats } from "@/lib/insights";
import { FreshnessStamp } from "@/app/components/freshness";
import { getUserProfile, getOrgProfile, orgKey } from "@/lib/profile";
import { browseQuery, type BrowseFilters } from "@/lib/browse";
import { getList } from "@/lib/lists";
import { Explorer, type ExploreInitial } from "@/app/admin/explore/explorer";

// Per-user paywall — never cache this page across requests.
export const dynamic = "force-dynamic";

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{
    country?: string; q?: string; payment?: string; shipping?: string;
    theme?: string; city?: string; category?: string; band?: string;
    new?: string; nopay?: string; launched?: string; list?: string;
    plus?: string; status?: string; checked?: string;
  }>;
}) {
  const email = await currentUser();
  if (!email) redirect("/login");
  // Auth + paywall are enforced by the (app) route-group layout; this page just renders.

  // Soft onboarding nudge — banner only, never blocks an existing user.
  const profile = await getUserProfile(email).catch(() => null);
  const org = profile ? await getOrgProfile(orgKey(email)).catch(() => null) : null;
  // Persona-lensed shortcut — points each company type at what it came for.
  const PERSONA: Record<string, { line: string; cta: string; href: string }> = {
    payments: { line: "See the payment landscape — every gateway ranked by adoption, with your own market report.", cta: "Product Partners", href: "/partners" },
    app_developer: { line: "See which apps merchants install and where the gaps are.", cta: "App landscape", href: "/partners" },
    shipping: { line: "See which carriers win at checkout across the market.", cta: "Carrier landscape", href: "/partners" },
    investor: { line: "Track how the market is growing — launches, churn and platform shift.", cta: "Market insights", href: "/insights" },
    researcher: { line: "Slice the full dataset and export what you need.", cta: "Open insights", href: "/insights" },
    agency: { line: "Find the merchants and the partners moving in your space.", cta: "Explore partners", href: "/partners" },
  };
  const persona = org ? PERSONA[org.companyType] : null;

  // Market for the header's live-feed badge. There is no picker any more — country
  // is a facet in the Explorer, which filters client-side with no round-trip — but
  // digest deep-links still arrive as ?country=KE, so honour the param.
  //
  // This used to call availableCountries() purely to validate the param, which put
  // another sequential query on the critical path. A shape check does the same job:
  // the value is a bound parameter, and an unknown code just returns no rows.
  const sp = await searchParams;
  const country = sp.country && /^[A-Za-z]{2}$/.test(sp.country) ? sp.country.toUpperCase() : "ZA";

  // Drill-through: insights links land here with a facet pre-applied
  // (e.g. /dashboard?payment=Paystack) — seed the Explorer's filters from them.
  const csv = (v?: string) => (v ? v.split(",").map((x) => x.trim()).filter(Boolean) : undefined);
  // ?launched=7d|30d|90d|365d seeds the LAUNCH-date filter (what people mean by
  // "new stores"); ?new=… seeds the separate discovery-date filter; ?nopay=1 seeds the
  // "no payment gateway yet" prospect list — both used by outbound digest deep-links.
  const recency = (["7d", "30d", "365d"] as const).includes(sp.new as never) ? (sp.new as "7d" | "30d" | "365d") : undefined;
  const launched = (["7d", "30d", "90d", "365d"] as const).includes(sp.launched as never)
    ? (sp.launched as "7d" | "30d" | "90d" | "365d") : undefined;
  const status = sp.status === "migrated" || sp.status === "dead" ? sp.status : undefined;
  const checkedDays = sp.checked && /^\d{1,4}$/.test(sp.checked) ? Number(sp.checked) : undefined;
  const drill: ExploreInitial = {
    q: sp.q,
    country: sp.country ? [sp.country] : undefined,
    payment: csv(sp.payment), shipping: csv(sp.shipping), theme: csv(sp.theme),
    city: csv(sp.city), category: csv(sp.category), band: csv(sp.band),
    recency, launched, noPayment: sp.nopay === "1",
    plus: sp.plus === "1" || undefined, status, checkedDays,
  };
  // ?list=<id> opens a Saved list — its stored view fully re-seeds the Explorer (overrides any drill).
  const savedView = sp.list ? await getList(email, sp.list).then((l) => l?.view ?? null).catch(() => null) : null;
  const initial: ExploreInitial = (savedView as ExploreInitial) ?? drill;

  // Tile numbers all come from the single getHomeStats() aggregate (one indexed
  // COUNT query) — same source as /insights and the homepage, so the counts agree.
  // Previously we also loaded EVERY lead just to count emails; getHomeStats already
  // computes that count, so we dropped the full-table load (it was the tiles' main
  // latency). Fall back to bundled samples only if the DB is unreachable.
  let live: boolean;
  let updatedAt: string | null;
  try {
    const home = await getHomeStats(country);
    if (!home.live) throw new Error("no live stores");
    live = true;
    updatedAt = home.updatedAt;
  } catch {
    live = false;
    updatedAt = null;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-cream/55">Fresh ecommerce stores across your markets, discovered as they launch.</p>
        <FreshnessStamp updatedAt={updatedAt} live={live} />
      </div>

      {!profile && (
        <Link href="/onboarding"
          className="flex items-center justify-between gap-3 rounded-2xl border border-mint/30 bg-mint/10 px-4 py-3 text-sm transition hover:bg-mint/15">
          <span className="text-cream/85"><b className="text-mint">Tailor your Terrain</b> — 60 seconds to set your persona, lead cadence and digest so we show you the right data.</span>
          <span className="shrink-0 rounded-full bg-mint px-3 py-1 text-xs font-semibold text-ink">Set up →</span>
        </Link>
      )}

      {persona && (
        <Link href={persona.href}
          className="flex items-center justify-between gap-3 rounded-2xl border border-lilac/25 bg-lilac/[0.06] px-4 py-3 text-sm transition hover:bg-lilac/10">
          <span className="text-cream/85">{persona.line}</span>
          <span className="shrink-0 rounded-full border border-lilac/40 px-3 py-1 text-xs font-semibold text-lilac">{persona.cta} →</span>
        </Link>
      )}

      {(status || sp.plus === "1") && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-cyan/25 bg-cyan/[0.06] px-4 py-2.5 text-sm">
          <span className="text-cream/85">
            Showing {status === "migrated" ? "stores that migrated off-platform" : status === "dead" ? "stores that went dark" : "Shopify Plus stores"}
            {launched ? ` · launched in the last ${launched.replace("d", " days")}` : checkedDays ? ` · in the last ${checkedDays} days` : ""}.
          </span>
          <Link href="/dashboard" className="shrink-0 font-medium text-cyan hover:underline">Clear →</Link>
        </div>
      )}

      <div>
        <div className="mb-3 flex items-baseline justify-between px-1">
          <h2 className="font-display text-2xl">Browse stores</h2>
          <span className="text-xs text-cream/40">
            {live ? "Live · refreshed every 10 minutes" : "Sample data — live feed unavailable"}
          </span>
        </div>
        {/* Streamed so the shell paints instantly — the full live set is a heavy load
            (~13k rich rows), so we don't block first paint on it. */}
        <Suspense fallback={<BrowseSkeleton />}>
          <BrowseSection initial={initial} />
        </Suspense>
      </div>
    </div>
  );
}

// Server-paginated (lib/browse.ts): SSR the first ~60-row page with the deep-link filters applied so
// the first paint already matches (the Explorer skips its first client fetch to honour this), then the
// Explorer refetches through browse() as filters change. Was ~7MB of leads to the browser; now tens of
// KB. Runs inside Suspense, off the page's critical path.
async function BrowseSection({ initial }: { initial?: import("@/app/admin/explore/explorer").ExploreInitial }) {
  const RMAP: Record<string, number> = { "7d": 7, "30d": 30, "365d": 365 };
  const LMAP: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90, "365d": 365 };
  const filters: BrowseFilters = {
    q: initial?.q || undefined,
    country: initial?.country, platform: initial?.platform, category: initial?.category, band: initial?.band,
    theme: initial?.theme, city: initial?.city, payment: initial?.payment, shipping: initial?.shipping,
    app: initial?.apps, activity: initial?.activity, hosting: initial?.hosting,
    plus: initial?.plus || undefined, hasEmail: initial?.email || undefined, noPayment: initial?.noPayment || undefined,
    tier: (initial?.tier || undefined) as BrowseFilters["tier"],
    status: initial?.status, checkedDays: initial?.checkedDays,
    launchedDays: initial?.launched ? LMAP[initial.launched] : undefined,
    discoveredDays: initial?.recency ? RMAP[initial.recency] : undefined,
    sort: initial?.sort as BrowseFilters["sort"],
    limit: 60,
  };
  const data = await browseQuery(filters).catch(() => null);
  if (!data || data.universe === 0) return <p className="py-10 text-center text-cream/40">No stores to browse yet.</p>;
  return <Explorer initialData={data} initial={initial} showStats />;
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
