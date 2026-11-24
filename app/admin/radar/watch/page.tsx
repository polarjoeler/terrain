import Link from "next/link";
import { redirect } from "next/navigation";
import { Wordmark } from "@/app/components/logo";
import { currentUser, isAdmin } from "@/lib/auth";
import { marketFlag } from "@/lib/markets";
import { cleanName } from "@/lib/brands";
import { confirmedFakes, fakeKinds, listCandidates, tableReady, tldMix, topBrands, watchSummary, weeklyTrend, BACKED, type Candidate, type ConfirmedFake } from "@/lib/radar/watch";
import { reviewCandidate } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Admin · Fakes" };

/** The fakes feed. One list, four tiers, strongest evidence first:
 *   Confirmed — a person took it out of the lead list (store_edits is the record);
 *   Likely    — tier-A look-alike name AND its catalogue overlaps the brand's (≥ BACKED);
 *   Watching  — tier-A look-alike name, no catalogue evidence yet;
 *   Weaker    — tier B, a name match only.
 *  Admin-only: none of this is shown to a customer (lib/radar/watch.ts). */
type View = "likely" | "watch" | "confirmed" | "weak" | "reviewed";
const VIEWS: { v: View; label: string; hint: string }[] = [
  { v: "likely", label: "Likely fake", hint: `Look-alike name and catalogue overlap ≥ ${BACKED}` },
  { v: "watch", label: "Watching", hint: "Look-alike name, no catalogue evidence yet" },
  { v: "confirmed", label: "Confirmed", hint: "Taken out of the lead list by a person" },
  { v: "weak", label: "Weaker matches", hint: "Name match only (tier B)" },
  { v: "reviewed", label: "Reviewed", hint: "Marked benign or dismissed" },
];

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
            {c.country && <span>{marketFlag(c.country)} {c.country}</span>}
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
          <Evidence c={c} />
        </div>
        <ReviewButtons c={c} />
      </div>
    </li>
  );
}


/** The evidence panel: everything we hold on the suspect, in one place, before a decision. */
function Evidence({ c }: { c: Candidate }) {
  const d = c.catalogDetail;
  const facts: [string, React.ReactNode][] = [
    ["Name on site", c.name && c.name !== c.suspect ? cleanName(c.name) : null],
    ["Platform", c.platform],
    ["Checkout", c.payments ? c.payments : "not read yet"],
    ["Status", c.live],
    ["First seen", c.seenAt ? new Date(c.seenAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : null],
    ["Catalogue checked", c.catalogCheckedAt ? ago(c.catalogCheckedAt) : "not yet"],
    ["Their products", d?.suspect_products != null ? d.suspect_products.toLocaleString() : null],
    ["Name score", String(c.score)],
  ];
  return (
    <details className="group mt-2">
      <summary className="cursor-pointer list-none text-[11px] font-semibold text-cyan/80 hover:text-cyan">
        <span className="group-open:hidden">Show evidence</span><span className="hidden group-open:inline">Hide evidence</span>
      </summary>
      <div className="mt-2 grid gap-3 rounded-xl border border-cream/10 bg-cream/[0.02] p-3 md:grid-cols-2">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
          {facts.filter(([, v]) => v != null && v !== "").map(([k, v]) => (
            <div key={k} className="contents"><dt className="text-cream/40">{k}</dt><dd className="break-words text-cream/75">{v}</dd></div>
          ))}
        </dl>
        <div className="space-y-2 text-[11px]">
          {d?.reasons?.length ? (
            <div><div className="text-cream/40">Why the catalogue matched</div><ul className="mt-0.5 list-disc pl-4 text-cream/70">{d.reasons.map((r) => <li key={r}>{r}</li>)}</ul></div>
          ) : null}
          {d?.sample?.length ? (
            <div><div className="text-cream/40">Shared products</div><ul className="mt-0.5 text-cream/60">{d.sample.slice(0, 8).map((t) => <li key={t} className="truncate">{t}</li>)}</ul></div>
          ) : null}
          <div className="flex flex-wrap gap-2 pt-1">
            <a href={`https://${c.suspect}`} target="_blank" rel="noopener noreferrer nofollow" className="rounded-full border border-cream/15 px-2.5 py-1 text-cream/70 hover:bg-cream/5">Open suspect ↗</a>
            <a href={`https://${c.brand}`} target="_blank" rel="noopener noreferrer" className="rounded-full border border-cream/15 px-2.5 py-1 text-cream/70 hover:bg-cream/5">Open brand ↗</a>
            <Link href={`/admin/explore?q=${encodeURIComponent(c.suspect)}`} className="rounded-full border border-cream/15 px-2.5 py-1 text-cream/70 hover:bg-cream/5">Open in Explorer</Link>
          </div>
        </div>
      </div>
    </details>
  );
}

function ConfirmedRow({ f }: { f: ConfirmedFake }) {
  return (
    <li className="border-t border-cream/[0.06] py-3 first:border-t-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <a href={`https://${f.domain}`} target="_blank" rel="noopener noreferrer nofollow" className="break-all font-mono text-sm text-cream hover:underline">{f.domain}</a>
            {f.country && <span className="text-xs">{marketFlag(f.country)}</span>}
            <span className="rounded-full bg-orange/15 px-2 py-0.5 text-[11px] font-semibold text-orange">Confirmed</span>
          </div>
          {f.name && f.name !== f.domain && <div className="mt-0.5 truncate text-xs text-cream/55">{cleanName(f.name)}</div>}
          <div className="mt-1 text-[11px] text-cream/65">{f.reason}</div>
          <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-cream/45">
            {f.platform && <span>{f.platform}</span>}
            {f.live && <span>{f.live}</span>}
            {f.payments && <span>checkout: {f.payments}</span>}
            <span>hidden from leads {ago(f.confirmedAt)}</span>
          </div>
        </div>
        <Link href={`/admin/explore?q=${encodeURIComponent(f.domain)}`} className="shrink-0 rounded-full border border-cream/15 px-2.5 py-1 text-[11px] text-cream/60 hover:bg-cream/5">Open in Explorer</Link>
      </div>
    </li>
  );
}

export default async function FakesFeed({ searchParams }: { searchParams: Promise<{ view?: string; status?: string; q?: string }> }) {
  const email = await currentUser();
  if (!email) redirect("/login");
  if (!isAdmin(email)) redirect("/dashboard");
  const sp = await searchParams;
  const view: View = VIEWS.some((x) => x.v === sp.view) ? (sp.view as View) : "likely";
  const reviewed = sp.status === "dismissed" ? "dismissed" : "benign";
  const q = (sp.q ?? "").slice(0, 80);

  const ready = await tableReady().catch(() => false);
  // Sequential on purpose: the shared pool must not take a fan-out (AGENTS.md rule 3).
  const summary = ready ? await watchSummary() : null;
  const confirmed = await confirmedFakes(view === "confirmed" ? q : undefined).catch(() => [] as ConfirmedFake[]);
  const kinds = fakeKinds(confirmed);
  const trend = ready ? await weeklyTrend() : [];
  const brands = ready ? await topBrands() : [];
  const tlds = ready ? await tldMix() : [];
  const rows = !ready || view === "confirmed" ? [] : await listCandidates(
    view === "likely" ? { tier: "A", status: "new", backed: true, q }
    : view === "watch" ? { tier: "A", status: "new", backed: false, q }
    : view === "weak" ? { tier: "B", status: "new", q }
    : { tier: "all", status: reviewed, q });
  const peak = Math.max(1, ...trend.map((t) => t.n));
  const href = (p: Record<string, string>) => `/admin/radar/watch?${new URLSearchParams({ view, ...(q ? { q } : {}), ...p })}`;
  const counts: Record<View, number | null> = {
    likely: summary?.likely ?? null,
    watch: summary ? summary.open - summary.likely : null,
    confirmed: view === "confirmed" && q ? null : confirmed.length,
    weak: summary?.tierB ?? null,
    reviewed: null,
  };

  return (
    <div className="min-h-screen px-4 py-6 md:px-8">
      <div className="mx-auto max-w-6xl">
        <nav className="flex items-center justify-between">
          <Link href="/"><Wordmark size="text-xl" /></Link>
          <div className="flex items-center gap-3 text-sm">
            <Link href="/admin/brands" className="text-cream/60 hover:text-cream">Brand index</Link>
            <Link href="/radar" className="text-cream/60 hover:text-cream">Copied catalogues</Link>
            <Link href="/admin" className="text-cream/60 hover:text-cream">← Admin</Link>
            <span className="rounded-full border border-orange/30 bg-orange/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-orange">Admin</span>
          </div>
        </nav>

        <header className="mt-10">
          <h1 className="font-display text-4xl text-cream">Fakes</h1>
          <p className="mt-2 max-w-3xl text-sm text-cream/60">
            Stores pretending to be a brand. Look-alike domains of top ZA, KE and NG stores and watchlist brands,
            ranked by how much evidence backs them, plus every store you&rsquo;ve already taken down.
            Admin-only: customers never see this list.
          </p>
        </header>

        <section className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-5">
          <Tile n={counts.confirmed ?? "—"} label="Confirmed fakes" accent />
          <Tile n={counts.likely ?? "—"} label="Likely fake" />
          <Tile n={counts.watch ?? "—"} label="Watching" />
          <Tile n={summary?.newThisWeek ?? "—"} label="New look-alikes this week" />
          <Tile n={summary?.gone ?? "—"} label={summary?.medianDaysAlive == null ? "Gone offline" : `Gone offline · median ${summary.medianDaysAlive}d alive`} />
        </section>

        {kinds.length > 0 && (
          <p className="mt-3 text-xs text-cream/45">
            Confirmed so far: {kinds.map((k) => `${k.n} ${k.kind.toLowerCase()}`).join(" · ")}.
          </p>
        )}

        <section className="mt-8">
          <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Evidence tier">
            {VIEWS.map((x) => (
              <Link key={x.v} href={href({ view: x.v })} role="tab" aria-selected={view === x.v} title={x.hint}
                className={`rounded-full border px-3.5 py-1.5 text-xs font-semibold ${view === x.v ? "border-orange/40 bg-orange/10 text-orange" : "border-cream/12 text-cream/60 hover:text-cream"}`}>
                {x.label}{counts[x.v] != null ? <span className="ml-1.5 font-mono font-normal opacity-70">{counts[x.v]!.toLocaleString()}</span> : null}
              </Link>
            ))}
            {view === "reviewed" && (
              <>
                <span className="mx-1 h-4 w-px bg-cream/10" />
                <Chip href={href({ status: "benign" })} on={reviewed === "benign"}>Benign</Chip>
                <Chip href={href({ status: "dismissed" })} on={reviewed === "dismissed"}>Dismissed</Chip>
              </>
            )}
            <form action="/admin/radar/watch" className="ml-auto">
              <input type="hidden" name="view" value={view} />
              <input name="q" defaultValue={q} placeholder="Brand or domain…" aria-label="Filter by brand or domain"
                className="w-48 rounded-full border border-cream/12 bg-transparent px-3 py-1.5 text-xs text-cream placeholder:text-cream/30" />
            </form>
          </div>
          <p className="mt-2 text-[11px] text-cream/40">{VIEWS.find((x) => x.v === view)!.hint}.</p>

          {!ready && view !== "confirmed" ? (
            <div className="mt-4 rounded-2xl border border-cream/12 p-6 text-sm text-cream/60">
              The <code className="font-mono">lookalike_candidates</code> table doesn&apos;t exist yet. Run{" "}
              <code className="font-mono">node --env-file=.env.local scripts/lookalike-scan.mjs --migrate</code> once on Rex, then the first scan.
            </div>
          ) : view === "confirmed" ? (
            <ul className="mt-4 rounded-2xl border border-cream/12 px-4">
              {confirmed.map((f) => <ConfirmedRow key={f.domain} f={f} />)}
              {!confirmed.length && <li className="py-6 text-center text-sm text-cream/40">Nothing confirmed{q ? " matching that" : " yet"}.</li>}
            </ul>
          ) : (
            <>
              <ul className="mt-4 rounded-2xl border border-cream/12 px-4">
                {rows.map((c) => <Row key={`${c.suspect}|${c.brand}`} c={c} />)}
                {!rows.length && (
                  <li className="py-6 text-center text-sm text-cream/40">
                    {view === "likely" ? "Nothing with catalogue evidence waiting. Check Watching for name-only look-alikes." : "Nothing here."}
                  </li>
                )}
              </ul>
              {rows.length >= 150 && <p className="mt-2 text-xs text-cream/40">Showing the first 150. Narrow with a brand or domain.</p>}
            </>
          )}
        </section>

        {ready && (
          <section className="mt-10 grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-cream/12 p-4">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-cream/45">Look-alikes by week first seen</h2>
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
              <p className="mt-2 text-[10px] text-cream/35">✓ = catalogue overlap ≥ {BACKED}</p>
            </div>
            <div className="rounded-2xl border border-cream/12 p-4">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-cream/45">Most-targeted brands</h2>
              <ul className="mt-3 space-y-1">
                {brands.map((b) => (
                  <li key={b.brand} className="flex items-center justify-between gap-2 text-xs">
                    <Link href={`/admin/radar/watch?${new URLSearchParams({ view: "watch", q: b.brand })}`} className="truncate font-mono text-cream/75 hover:underline">{b.brand}</Link>
                    <span className="shrink-0 font-mono text-cream/45">{b.n} · {ago(b.latest)}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-2xl border border-cream/12 p-4">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-cream/45">Domain endings</h2>
              <ul className="mt-3 space-y-1">
                {tlds.map((t) => (
                  <li key={t.tld} className="flex justify-between font-mono text-xs text-cream/70"><span>.{t.tld}</span><span className="text-cream/45">{t.n}</span></li>
                ))}
              </ul>
              {summary?.lastRun && <p className="mt-4 text-[10px] text-cream/35">Last scan {ago(summary.lastRun)}</p>}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
