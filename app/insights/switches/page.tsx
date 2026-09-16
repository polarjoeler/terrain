import { redirect } from "next/navigation";
import Link from "next/link";
import { Wordmark } from "@/app/components/logo";
import { currentUser, isAdmin } from "@/lib/auth";
import { getSubscriber, hasAccess } from "@/lib/subscriptions";
import { switchesLog } from "@/lib/provider-insights";
import { providerSlug } from "@/lib/provider-slug";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Payment provider switches" };

/** The full, filterable switches log — every gateway change event, searchable by date range.
 *  Opened from the "Recent switches" feed on insights and on each provider page. */
export default async function SwitchesPage({
  searchParams,
}: {
  searchParams: Promise<{ provider?: string; country?: string; from?: string; to?: string }>;
}) {
  const email = await currentUser();
  if (!email) redirect("/login");
  const paid = email ? hasAccess(await getSubscriber(email).catch(() => null)) : false;
  if (!isAdmin(email) && !paid) redirect("/billing");

  const sp = await searchParams;
  const provider = sp.provider || undefined;
  const country = sp.country || undefined;
  const from = sp.from || undefined;
  const to = sp.to || undefined;

  const shifts = await switchesLog({ provider, country, from, to, limit: 500 }).catch(() => []);
  const backHref = provider ? `/p/${providerSlug(provider)}${country ? `?country=${country}` : ""}` : `/insights${country ? `?country=${country}` : ""}`;
  const ranged = !!(from || to);

  return (
    <main className="min-h-screen px-4 py-6 md:px-8">
      <div className="mx-auto max-w-3xl">
        <nav className="flex items-center justify-between">
          <Link href="/"><Wordmark size="text-lg" /></Link>
          <Link href={backHref} className="text-sm text-cream/60 hover:text-cream">← Back</Link>
        </nav>

        <header className="mt-8">
          <h1 className="font-display text-4xl text-cream md:text-5xl">
            {provider ? `${provider} switches` : "Payment provider switches"}
          </h1>
          <p className="mt-2 text-cream/60">
            {shifts.length.toLocaleString()} gateway change{shifts.length === 1 ? "" : "s"}
            {provider ? <> involving <span className="text-cream/85">{provider}</span></> : null}
            {country ? <> in <span className="text-cream/85">{country}</span></> : null}
            {ranged ? <> from <span className="text-cream/85">{from || "start"}</span> to <span className="text-cream/85">{to || "now"}</span></> : <> — most recent first</>}.
          </p>

          {/* Date-range filter — a plain GET form, so it works with the page's loading state. */}
          <form method="get" className="mt-5 flex flex-wrap items-end gap-3 text-xs text-cream/50">
            {provider && <input type="hidden" name="provider" value={provider} />}
            {country && <input type="hidden" name="country" value={country} />}
            <label className="flex flex-col gap-1">From
              <input type="date" name="from" defaultValue={from} className="rounded border border-cream/15 bg-transparent px-2 py-1 text-cream" />
            </label>
            <label className="flex flex-col gap-1">To
              <input type="date" name="to" defaultValue={to} className="rounded border border-cream/15 bg-transparent px-2 py-1 text-cream" />
            </label>
            <button type="submit" className="rounded-full bg-cyan px-4 py-1.5 font-semibold text-cyan-deep">Apply</button>
            {ranged && (
              <Link href={`/insights/switches?${new URLSearchParams({ ...(provider ? { provider } : {}), ...(country ? { country } : {}) }).toString()}`}
                className="py-1.5 text-cream/45 hover:text-cream">Clear dates</Link>
            )}
          </form>
        </header>

        {shifts.length === 0 ? (
          <p className="mt-10 text-sm text-cream/40">No switches{ranged ? " in this date range" : ""} yet — detected as stores are re-probed on the 60-day cycle.</p>
        ) : (
          <ul className="mt-8 divide-y divide-cream/[0.06]">
            {shifts.map((s, i) => {
              const swap = s.added.length === 1 && s.removed.length === 1;
              return (
                <li key={i} className="py-3">
                  <div className="flex flex-wrap items-center gap-1.5 text-sm">
                    {swap ? (
                      <>
                        <span className="text-orange/75 line-through decoration-orange/40">{s.removed[0]}</span>
                        <span className="text-cream/30">→</span>
                        <span className="font-semibold text-mint">{s.added[0]}</span>
                      </>
                    ) : (
                      <>
                        {s.added.map((a) => <span key={`a${a}`} className="rounded bg-mint/15 px-2 py-0.5 text-xs font-medium text-mint">+ {a}</span>)}
                        {s.removed.map((r) => <span key={`r${r}`} className="rounded bg-orange/15 px-2 py-0.5 text-xs font-medium text-orange">− {r}</span>)}
                      </>
                    )}
                  </div>
                  <div className="mt-1 flex items-baseline justify-between gap-2 text-[11px] text-cream/35">
                    <a href={`https://${s.domain}`} target="_blank" rel="noopener noreferrer" className="truncate font-mono hover:text-cream hover:underline">{s.domain}</a>
                    <span className="shrink-0 tabular-nums">{s.changedAt}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
