import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getHomeStats, availableCountries, platformLabel } from "@/lib/insights";
import { cachedAgg } from "@/lib/agg-cache";
import { db } from "@/lib/db";
import { marketLabel, marketFlag, FOCUS_MARKETS } from "@/lib/markets";
import { FreshnessStamp } from "@/app/components/freshness";
import { getOrgProfile, orgKey } from "@/lib/profile";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Overview" };

const prettify = (s: string) =>
  s.replace(/[._-]+/g, " ").trim().split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") || s;

// One cached bundle for the breadth cards (markets + platforms). availableCountries is already
// cached (1h); availablePlatforms isn't, so the whole bundle gets a short durable cache so the
// page paints instantly after the first warm hit. Sequential (never Promise.all on the pool).
async function breadth(): Promise<{ countries: { country: string; stores: number }[]; platforms: { platform: string; live: number }[] }> {
  return cachedAgg("overview:breadth:v2", 10 * 60 * 1000, async () => {
    const countries = await availableCountries();
    // Platform mix SCOPED to the focus markets (availablePlatforms is global, which would dwarf the
    // market numbers with the worldwide import backlog). Fold NULL platform → Shopify, matching
    // platformClause / availablePlatforms. Same published + live filter as availableCountries.
    const sql = db();
    const rows = await sql.begin(async (t) => {
      await t`SET LOCAL statement_timeout = '20s'`;
      return t<{ p: string | null; n: number }[]>`
        SELECT lower(platform) p, COUNT(*)::int n FROM imported_stores
        WHERE published AND country = ANY(${[...FOCUS_MARKETS]})
          AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
        GROUP BY 1`;
    });
    let shopify = 0;
    const others: { platform: string; live: number }[] = [];
    for (const r of rows) {
      const n = Number(r.n);
      if (r.p === "shopify" || r.p == null) shopify += n;
      else if (n >= 10) others.push({ platform: r.p, live: n });
    }
    others.sort((a, b) => b.live - a.live);
    return { countries, platforms: [{ platform: "shopify", live: shopify }, ...others] };
  }).catch(() => ({ countries: [], platforms: [] }));
}

export default async function OverviewPage() {
  const email = await currentUser();
  if (!email) redirect("/login");

  const org = await getOrgProfile(orgKey(email)).catch(() => null);
  const name = prettify(email.split("@")[0] || "there");

  const { countries, platforms } = await breadth();
  const primary = countries[0]?.country ?? "ZA";
  const home = await getHomeStats(primary);

  const totalTracked = countries.reduce((a, c) => a + c.stores, 0) || home.storesTracked;
  const marketName = marketLabel(primary).replace(/^[^\p{L}]+/u, "");
  const otherMarkets = Math.max(0, countries.length - 1);

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      {/* Hero */}
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-3xl text-cream md:text-4xl">Good to see you, {name}</h2>
          <p className="mt-1.5 text-sm text-cream/55">
            {totalTracked.toLocaleString()} stores tracked across {countries.length || 1} market{countries.length === 1 ? "" : "s"} — discovered as they launch.
          </p>
        </div>
        <FreshnessStamp updatedAt={home.updatedAt} live={home.live} />
      </section>

      {/* KPI tiles — this week's movement in the primary market */}
      <section>
        <div className="mb-2 flex items-baseline gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-cream/45">This week</h3>
          <span className="text-xs text-cream/35">in {marketName}{otherMarkets > 0 ? ` · +${otherMarkets} more market${otherMarkets === 1 ? "" : "s"} below` : ""}</span>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile accent="mint" label="Stores tracked" value={totalTracked} sub={`all ${countries.length || 1} markets`} href="/dashboard" />
          <StatTile accent="cyan" label="New this week" value={home.newThisWeek} sub={`launched in ${marketName}`} href="/dashboard?launched=7d" />
          <StatTile accent="lilac" label="Shopify Plus" value={home.plusFlagged} sub="high-value merchants" href="/dashboard?band=plus" />
          <StatTile accent="orange" label="With contact email" value={home.withEmail ?? 0} sub="reachable leads" href="/dashboard" />
        </div>
      </section>

      {/* Breadth: markets + platforms */}
      <section className="grid gap-5 lg:grid-cols-2">
        <Panel title="Markets covered" cta={{ label: "Country insights →", href: "/insights" }}>
          {countries.length === 0 ? (
            <Empty>Market data is warming up.</Empty>
          ) : (
            <BarList rows={countries.slice(0, 7).map((c) => ({
              key: c.country, label: `${marketFlag(c.country)} ${marketLabel(c.country).replace(/^[^\p{L}]+/u, "")}`,
              value: c.stores, href: `/dashboard?country=${c.country}`,
            }))} tone="mint" />
          )}
        </Panel>

        <Panel title="Platform mix" cta={{ label: "Platform insights →", href: "/insights" }}>
          {platforms.length === 0 ? (
            <Empty>Platform data is warming up.</Empty>
          ) : (
            <BarList rows={platforms.slice(0, 7).map((p) => ({
              key: p.platform, label: platformLabel(p.platform), value: p.live,
            }))} tone="lilac" />
          )}
        </Panel>
      </section>

      {/* Quick actions */}
      <section>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-cream/45">Jump back in</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <ActionCard href="/dashboard" title="Browse leads" desc="Filter the full store database and export your shortlist." />
          <ActionCard href="/insights" title="Market intelligence" desc="Payments, platforms and growth by country and technology." />
          <ActionCard href="/partners" title="Partner finder" desc="Agencies, apps and service partners moving in your space." />
          <ActionCard href="/radar" title="Fraud scanner" desc="Flag suspected clone and abuse signals across stores." />
          <ActionCard href="/digests" title="Your digests" desc="The recurring briefings tailored to your goals." />
          {!org && <ActionCard href="/onboarding" title="Finish setup" desc="Tell Terrain who you target so we surface the right data." accent />}
        </div>
      </section>
    </div>
  );
}

/* ----------------------------------------------------------------- atoms --- */
const ACCENTS: Record<string, string> = {
  mint: "text-mint", cyan: "text-cyan", lilac: "text-lilac", orange: "text-orange",
};
function StatTile({ label, value, sub, accent, href }: { label: string; value: number; sub: string; accent: keyof typeof ACCENTS | string; href: string }) {
  return (
    <Link href={href} className="group rounded-2xl border border-cream/10 bg-cream/[0.02] p-4 transition hover:border-cream/25 hover:bg-cream/[0.04]">
      <div className={`text-[11px] font-medium uppercase tracking-wide ${ACCENTS[accent] ?? "text-cream/50"}`}>{label}</div>
      <div className="mt-2 font-display text-3xl tabular-nums text-cream">{value.toLocaleString()}</div>
      <div className="mt-0.5 text-xs text-cream/40">{sub}</div>
    </Link>
  );
}

function Panel({ title, cta, children }: { title: string; cta?: { label: string; href: string }; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-cream/10 bg-cream/[0.02] p-5">
      <div className="mb-4 flex items-baseline justify-between">
        <h3 className="font-display text-lg text-cream">{title}</h3>
        {cta && <Link href={cta.href} className="text-xs text-cream/45 transition hover:text-mint">{cta.label}</Link>}
      </div>
      {children}
    </div>
  );
}

function BarList({ rows, tone }: { rows: { key: string; label: string; value: number; href?: string }[]; tone: "mint" | "lilac" }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const bar = tone === "mint" ? "bg-mint/70" : "bg-lilac/70";
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => {
        const inner = (
          <>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="truncate text-cream/80">{r.label}</span>
              <span className="shrink-0 tabular-nums text-cream/50">{r.value.toLocaleString()}</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-cream/[0.06]">
              <div className={`h-full rounded-full ${bar}`} style={{ width: `${Math.max(3, (100 * r.value) / max)}%` }} />
            </div>
          </>
        );
        return (
          <li key={r.key}>
            {r.href ? <Link href={r.href} className="block rounded-lg p-1 -m-1 transition hover:bg-cream/[0.03]">{inner}</Link> : inner}
          </li>
        );
      })}
    </ul>
  );
}

function ActionCard({ href, title, desc, accent }: { href: string; title: string; desc: string; accent?: boolean }) {
  return (
    <Link href={href}
      className={`group flex flex-col gap-1 rounded-2xl border p-4 transition ${accent ? "border-mint/30 bg-mint/[0.06] hover:bg-mint/10" : "border-cream/10 bg-cream/[0.02] hover:border-cream/25 hover:bg-cream/[0.04]"}`}>
      <div className="flex items-center justify-between">
        <span className="font-medium text-cream">{title}</span>
        <span className="text-cream/30 transition group-hover:translate-x-0.5 group-hover:text-cream/60">→</span>
      </div>
      <span className="text-xs leading-snug text-cream/50">{desc}</span>
    </Link>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-cream/35">{children}</p>;
}
