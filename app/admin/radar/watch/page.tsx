import Link from "next/link";
import { redirect } from "next/navigation";
import { Wordmark } from "@/app/components/logo";
import { currentUser, isAdmin } from "@/lib/auth";
import { marketFlag } from "@/lib/markets";
import { listCandidates, tableReady, tldMix, topBrands, watchSummary, weeklyTrend, type Candidate } from "@/lib/radar/watch";
import { reviewCandidate } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Admin · Radar Watch" };

const ago = (iso: string | null) => {
  if (!iso) return "—";
  const d = (Date.now() - new Date(iso).getTime()) / 864e5;
  return d < 1 ? "today" : d < 2 ? "yesterday" : d < 60 ? `${Math.floor(d)}d ago` : new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" });
};

function Tile({ n, label, accent }: { n: number | string; label: string; accent?: boolean }) {
  return (
    <div className={`rounded-2xl border p-4 ${accent ? "border-orange/30 bg-orange/[0.06]" : "border-cream/12"}`}>
      <div className={`font-display text-3xl ${accent ? "text-orange" : "text-cream"}`}>{n}</div>
      <div className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-cream/45">{label}</div>
    </div>
  );
}

function Chip({ href, on, children }: { href: string; on: boolean; children: React.ReactNode }) {
  return (
    <Link href={href} className={`rounded-full border px-3 py-1 text-xs ${on ? "border-orange/40 bg-orange/10 text-orange" : "border-cream/12 text-cream/60 hover:text-cream"}`}>
      {children}
    </Link>
  );
}

function ReviewButtons({ c }: { c: Candidate }) {
  const opts: { status: string; label: string; cls: string }[] =
    c.status === "new"
      ? [
          { status: "confirmed", label: "Clone", cls: "border-orange/40 text-orange hover:bg-orange/10" },
          { status: "benign", label: "Benign", cls: "border-cream/15 text-cream/70 hover:bg-cream/5" },
          { status: "dismissed", label: "Dismiss", cls: "border-cream/10 text-cream/45 hover:bg-cream/5" },
        ]
      : [{ status: "new", label: "Reopen", cls: "border-cream/15 text-cream/60 hover:bg-cream/5" }];
  return (
    <div className="flex shrink-0 gap-1.5">
      {opts.map((o) => (
        <form key={o.status} action={reviewCandidate}>
          <input type="hidden" name="suspect" value={c.suspect} />
          <input type="hidden" name="brand" value={c.brand} />
          <input type="hidden" name="status" value={o.status} />
          <button type="submit" title={o.status === "confirmed" ? "Mark as a clone and hide it from the lead list" : undefined}
            className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${o.cls}`}>{o.label}</button>
        </form>
      ))}
    </div>
  );
}

function Row({ c }: { c: Candidate }) {
  const d = c.catalogDetail;
  return (
    <li className="border-t border-cream/[0.06] py-3 first:border-t-0">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <a href={`https://${c.suspect}`} target="_blank" rel="noopener noreferrer nofollow" className="break-all font-mono text-sm text-cream hover:underline">{c.suspect}</a>
            <span className="text-xs text-cream/40">→</span>
            <a href={`https://${c.brand}`} target="_blank" rel="noopener noreferrer" className="break-all font-mono text-xs text-cream/60 hover:underline">{c.brand}</a>
            {c.brandMarket && <span className="text-xs">{c.brandMarket === "watchlist" ? "★" : marketFlag(c.brandMarket)}</span>}
            {c.brandRank ? <span className="font-mono text-[11px] text-cream/35">#{c.brandRank}</span> : null}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-cream/50">
            <span>seen {ago(c.seenAt)}</span>
            {c.platform && <span>{c.platform}</span>}
            {c.live && <span className={c.live === "dead" ? "text-cream/30" : ""}>{c.live}</span>}
            {c.published && <span className="text-orange/80">sold as a lead</span>}
            {c.unpublishedLead && <span>hidden from leads</span>}
          </div>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {c.signals.map((s) => <li key={s} className="rounded-full bg-cream/[0.06] px-2 py-0.5 text-[11px] text-cream/65">{s}</li>)}
          </ul>
          {d && (
            <div className="mt-2 text-[11px] text-cream/55">
              {d.error ? (
                <span className="text-cream/35">Catalogue not readable: {d.error}</span>
              ) : (
                <>
                  <span className={c.catalogScore !== null && c.catalogScore >= 50 ? "font-semibold text-orange" : ""}>
                    Catalogue overlap {c.catalogScore}
                  </span>
                  {d.reasons?.length ? ` · ${d.reasons.slice(0, 2).join(", ")}` : ""}
                  {d.sample?.length ? <span className="block truncate text-cream/35">e.g. {d.sample.slice(0, 4).join(" · ")}</span> : null}
                  {c.evidenceAt && <span className="block text-cream/35">Evidence frozen {ago(c.evidenceAt)}</span>}
                </>
              )}
            </div>
          )}
        </div>
        <ReviewButtons c={c} />
      </div>
    </li>
  );
}

export default async function RadarWatch({ searchParams }: { searchParams: Promise<{ tier?: string; status?: string; q?: string }> }) {
  const email = await currentUser();
  if (!email) redirect("/login");
  if (!isAdmin(email)) redirect("/dashboard");
  const sp = await searchParams;
  const tier = sp.tier ?? "A", status = sp.status ?? "new", q = sp.q ?? "";

  const ready = await tableReady().catch(() => false);
  // Sequential on purpose: the shared pool must not take a fan-out (AGENTS.md rule 3).
  const summary = ready ? await watchSummary() : null;
  const trend = ready ? await weeklyTrend() : [];
  const brands = ready ? await topBrands() : [];
  const tlds = ready ? await tldMix() : [];
  const rows = ready ? await listCandidates({ tier, status, q }) : [];
  const peak = Math.max(1, ...trend.map((t) => t.n));
  const href = (p: Record<string, string>) => `/admin/radar/watch?${new URLSearchParams({ tier, status, ...(q ? { q } : {}), ...p })}`;

  return (
    <div className="min-h-screen px-4 py-6 md:px-8">
      <div className="mx-auto max-w-6xl">
        <nav className="flex items-center justify-between">
          <Link href="/"><Wordmark size="text-xl" /></Link>
          <div className="flex items-center gap-3 text-sm">
            <Link href="/admin/brands" className="text-cream/60 hover:text-cream">Brand index</Link>
            <Link href="/admin" className="text-cream/60 hover:text-cream">← Admin</Link>
            <span className="rounded-full border border-orange/30 bg-orange/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-orange">Admin</span>
          </div>
        </nav>

        <header className="mt-10">
          <h1 className="font-display text-4xl text-cream">Radar Watch</h1>
          <p className="mt-2 max-w-3xl text-sm text-cream/60">
            Domains wearing the name of a top-1,000 ZA, KE or NG store, or a watchlist brand. Tier A adds a bait word
            (official, sale, outlet, promo, deal) or a throwaway TLD on a new domain. A daily lane checks the
            catalogue of up to 60 of them against the brand. These are leads for you to judge, not accusations.
          </p>
        </header>

        {!ready ? (
          <div className="mt-8 rounded-2xl border border-cream/12 p-6 text-sm text-cream/60">
            The <code className="font-mono">lookalike_candidates</code> table doesn&apos;t exist yet. Run{" "}
            <code className="font-mono">node --env-file=.env.local scripts/lookalike-scan.mjs --migrate</code> once on Rex, then the first scan.
          </div>
        ) : (
          <>
            <section className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-6">
              <Tile n={summary!.open} label="Tier A to review" accent />
              <Tile n={summary!.newThisWeek} label="New this week" />
              <Tile n={summary!.catalogueBacked} label="Catalogue overlap ≥ 50" />
              <Tile n={summary!.confirmed} label="Confirmed clones" />
              <Tile n={summary!.tierB} label="Tier B (weaker)" />
              <Tile
                n={summary!.gone}
                label={summary!.medianDaysAlive === null ? "Gone offline" : `Gone offline · median ${summary!.medianDaysAlive}d alive`}
              />
            </section>

            <section className="mt-6 grid gap-4 md:grid-cols-3">
              <div className="rounded-2xl border border-cream/12 p-4 md:col-span-1">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-cream/45">Tier A by week first seen</h2>
                <ul className="mt-3 space-y-1.5">
                  {trend.map((t) => (
                    <li key={t.week} className="flex items-center gap-2 font-mono text-[11px] text-cream/55">
                      <span className="w-20 shrink-0">{t.week.slice(5)}</span>
                      <span className="h-2 flex-1 rounded-full bg-cream/[0.06]">
                        <span className="block h-2 rounded-full bg-orange-soft/70" style={{ width: `${(t.n / peak) * 100}%` }} />
                      </span>
                      <span className="w-14 shrink-0 text-right">{t.n}{t.backed ? ` · ${t.backed}✓` : ""}</span>
                    </li>
                  ))}
                  {!trend.length && <li className="text-xs text-cream/40">Nothing yet.</li>}
                </ul>
                <p className="mt-2 text-[10px] text-cream/35">✓ = catalogue overlap ≥ 50</p>
              </div>
              <div className="rounded-2xl border border-cream/12 p-4">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-cream/45">Most-targeted brands</h2>
                <ul className="mt-3 space-y-1">
                  {brands.map((b) => (
                    <li key={b.brand} className="flex items-center justify-between gap-2 text-xs">
                      <Link href={`/admin/radar/watch?${new URLSearchParams({ tier: "all", status: "all", q: b.brand })}`} className="truncate font-mono text-cream/75 hover:underline">{b.brand}</Link>
                      <span className="shrink-0 font-mono text-cream/45">{b.n} · {ago(b.latest)}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="rounded-2xl border border-cream/12 p-4">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-cream/45">Domain endings (tier A)</h2>
                <ul className="mt-3 space-y-1">
                  {tlds.map((t) => (
                    <li key={t.tld} className="flex justify-between font-mono text-xs text-cream/70"><span>.{t.tld}</span><span className="text-cream/45">{t.n}</span></li>
                  ))}
                </ul>
                {summary!.lastRun && <p className="mt-4 text-[10px] text-cream/35">Last scan {ago(summary!.lastRun)}</p>}
              </div>
            </section>

            <section className="mt-8">
              <div className="flex flex-wrap items-center gap-2">
                <Chip href={href({ tier: "A" })} on={tier === "A"}>Tier A</Chip>
                <Chip href={href({ tier: "B" })} on={tier === "B"}>Tier B</Chip>
                <Chip href={href({ tier: "all" })} on={tier === "all"}>All tiers</Chip>
                <span className="mx-1 h-4 w-px bg-cream/10" />
                {["new", "confirmed", "benign", "dismissed", "all"].map((s) => (
                  <Chip key={s} href={href({ status: s })} on={status === s}>{s === "new" ? "To review" : s[0].toUpperCase() + s.slice(1)}</Chip>
                ))}
                <form action="/admin/radar/watch" className="ml-auto">
                  <input type="hidden" name="tier" value={tier} />
                  <input type="hidden" name="status" value={status} />
                  <input name="q" defaultValue={q} placeholder="Brand or domain…"
                    className="w-48 rounded-full border border-cream/12 bg-transparent px-3 py-1 text-xs text-cream placeholder:text-cream/30" />
                </form>
              </div>
              <ul className="mt-4 rounded-2xl border border-cream/12 px-4">
                {rows.map((c) => <Row key={`${c.suspect}|${c.brand}`} c={c} />)}
                {!rows.length && <li className="py-6 text-center text-sm text-cream/40">Nothing here.</li>}
              </ul>
              {rows.length >= 150 && <p className="mt-2 text-xs text-cream/40">Showing the first 150. Narrow with a brand or domain.</p>}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
