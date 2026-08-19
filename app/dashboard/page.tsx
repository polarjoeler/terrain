import Link from "next/link";
import { redirect } from "next/navigation";
import { Wordmark } from "@/app/components/logo";
import { currentUser } from "@/lib/auth";
import { sampleLeads } from "@/lib/leads";
import { fetchLeads, summarise, dataUpdatedAt } from "@/lib/sheets";
import { FreshnessStamp } from "@/app/components/freshness";
import { marketOf } from "@/lib/prioritize";
import {
  exportQuota,
  getSubscriber,
  hasAccess,
  trialDaysLeft,
} from "@/lib/subscriptions";
import { LeadsTable } from "./leads-table";

// Per-user paywall — never cache this page across requests.
export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const email = await currentUser();
  if (!email) redirect("/login");

  const subscriber = await getSubscriber(email);
  if (!hasAccess(subscriber)) redirect("/billing");

  const daysLeft = trialDaysLeft(subscriber);

  const { leads, live } = await fetchLeads();
  // Japan will get its own dedicated site — exclude it here.
  const source = live && leads.length ? leads : sampleLeads;
  const data = source.filter((l) => marketOf(l) !== "Japan");
  const s = summarise(data);

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
                  Live feed · {s.newThisWeek} new this week
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
            <FreshnessStamp updatedAt={dataUpdatedAt(data)} live={live && leads.length > 0} />
          </div>
        </header>

        <div className="mt-8 grid gap-4 md:grid-cols-4">
          <div className="rounded-3xl bg-mint p-5 text-ink">
            <div className="font-display text-4xl">+{s.newThisWeek}</div>
            <div className="mt-1 text-xs font-semibold uppercase tracking-wide opacity-70">
              New this week
            </div>
          </div>
          <div className="rounded-3xl bg-lilac p-5 text-ink">
            <div className="font-display text-4xl">{s.plusFlagged}</div>
            <div className="mt-1 text-xs font-semibold uppercase tracking-wide opacity-70">
              Shopify Plus
            </div>
          </div>
          <div className="rounded-3xl border border-cream/15 p-5">
            <div className="font-display text-4xl">{s.withEmail}</div>
            <div className="mt-1 text-xs font-semibold uppercase tracking-wide text-cream/50">
              With direct email
            </div>
          </div>
          <div className="rounded-3xl border border-cream/15 p-5">
            <div className="font-display text-4xl">{s.storesTracked}</div>
            <div className="mt-1 text-xs font-semibold uppercase tracking-wide text-cream/50">
              Stores tracked
            </div>
          </div>
        </div>

        <LeadsTable
          leads={data}
          canExport={subscriber?.plan === "pro" && hasAccess(subscriber)}
          exportRemaining={exportQuota(subscriber).remaining}
        />

        <p className="mt-6 text-center text-xs text-cream/40">
          {live
            ? "Live data from the discovery pipeline · refreshed every 10 minutes"
            : "Showing bundled sample data — live feed unavailable"}
        </p>
      </div>
    </div>
  );
}
