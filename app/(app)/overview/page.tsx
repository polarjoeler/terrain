import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { overviewData } from "@/lib/overview";
import { getAccount } from "@/lib/account";
import { getOrgProfile, orgKey } from "@/lib/profile";
import { marketLabel, marketFlag } from "@/lib/markets";
import { weekRead, type Read } from "@/lib/read";
import { StatChip, LaunchTrend } from "@/app/components/command";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Overview" };

const cleanMarket = (iso: string) => marketLabel(iso).replace(/^[^\p{L}]+/u, "");
const PLAT_TONE: Record<string, string> = { shopify: "text-cyan bg-cyan/10", woocommerce: "text-lilac bg-lilac/10" };
function platTone(p: string | null) { return PLAT_TONE[(p ?? "").toLowerCase()] ?? "text-mint bg-mint/10"; }
function platName(p: string | null) { const l = (p ?? "").toLowerCase(); return l === "woocommerce" ? "WooCommerce" : l === "shopify" || !l ? "Shopify" : p!.charAt(0).toUpperCase() + p!.slice(1); }
function daysAgo(iso: string) {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 864e5);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d}d ago`;
}
// Personalised focus strip, driven by the company type captured at signup.
const PERSONA: Record<string, { focus: string; line: string; ctas: { label: string; href: string }[] }> = {
  payments: { focus: "Payments", line: "Who's winning checkout — and the new stores with no gateway yet.", ctas: [{ label: "Provider momentum", href: "/insights/payments" }, { label: "No-gateway prospects", href: "/dashboard?nopay=1" }] },
  app_developer: { focus: "Apps", line: "Where merchants are installing — and the gaps for your app.", ctas: [{ label: "App landscape", href: "/insights/apps" }] },
  shipping: { focus: "Shipping", line: "Which carriers are winning at checkout across the market.", ctas: [{ label: "Carrier landscape", href: "/insights/shipping" }] },
  investor: { focus: "Market growth", line: "Launches, churn and platform shift across the market.", ctas: [{ label: "Market insights", href: "/insights" }] },
  researcher: { focus: "The full dataset", line: "Slice every signal and export what you need.", ctas: [{ label: "Open insights", href: "/insights" }, { label: "Browse leads", href: "/dashboard" }] },
  agency: { focus: "Partners & merchants", line: "The agencies and brands moving in your space.", ctas: [{ label: "Explore partners", href: "/partners" }] },
};

function greeting() {
  const h = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: "Africa/Johannesburg" }).format(new Date()));
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export default async function OverviewPage() {
  const email = await currentUser();
  if (!email) redirect("/login");

  const [data, account, org, reads] = [await overviewData(), await getAccount(email).catch(() => null), await getOrgProfile(orgKey(email)).catch(() => null), await weekRead().catch(() => [] as Read[])];
  const { pulse, launches, trend, markets } = data;
  const name = (account?.name ?? "there").split(" ")[0];
  const persona = org?.companyType ? PERSONA[org.companyType] : null;
  const marketMax = Math.max(1, ...markets.map((m) => m.live));

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {/* Hero */}
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-3xl font-bold tracking-tight text-cream md:text-4xl">{greeting()}, {name}.</h2>
          <p className="mt-1.5 text-sm text-cream/55">
            While you were away, <span className="font-mono text-cream/80">{pulse.newWeek.toLocaleString()}</span> stores launched across your markets this week — and <span className="font-mono text-cream/80">{pulse.totalLive.toLocaleString()}</span> are live in total.
          </p>
        </div>
        <span className="flex items-center gap-2 rounded-full border border-mint/25 bg-mint/[0.07] px-3 py-1.5 text-xs font-medium text-mint">
          <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-mint/60" /><span className="relative inline-flex h-2 w-2 rounded-full bg-mint" /></span>
          Live · launch-dated
        </span>
      </section>

      {/* While you were away */}
      <section>
        <h3 className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-cream/45">This week <span className="font-normal text-cream/30">· vs the week before · launch-dated, so scan volume can't skew it</span></h3>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatChip label="New stores" value={pulse.newWeek} prev={pulse.newPrev} accent="mint" href="/dashboard?launched=7d" />
          <StatChip label="Shopify Plus" value={pulse.plusWeek} accent="lilac" sub="new, this week" href="/dashboard?launched=7d&plus=1" />
          <StatChip label="Migrations" value={pulse.migWeek} prev={pulse.migPrev} accent="cyan" sub="off / onto platforms" href="/dashboard?status=migrated&checked=7" />
          <StatChip label="Went dark" value={pulse.churnWeek} prev={pulse.churnPrev} accent="orange" goodUp={false} href="/dashboard?status=dead&checked=7" />
        </div>
      </section>

      {/* Personalised focus — from the company type captured at signup */}
      {persona && (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-lilac/20 bg-lilac/[0.05] px-5 py-3.5">
          <div className="text-sm">
            <span className="font-semibold text-lilac">Your focus · {persona.focus}</span>
            <span className="ml-2 text-cream/60">{persona.line}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {persona.ctas.map((c) => (
              <Link key={c.href} href={c.href} className="rounded-full border border-lilac/30 px-3 py-1.5 text-xs font-medium text-lilac transition hover:bg-lilac/10">{c.label} →</Link>
            ))}
          </div>
        </section>
      )}

      {/* Terrain's read on the week */}
      <ReadPanel reads={reads} />

      {/* Launch stream */}
      <section className="rounded-2xl border border-cream/10 bg-cream/[0.02] p-5 md:p-6">
        <div className="mb-4 flex items-baseline justify-between">
          <div>
            <h3 className="font-display text-lg text-cream">Launch stream</h3>
            <p className="mt-0.5 text-xs text-cream/45">Stores going live each day across your markets, by platform.</p>
          </div>
          <Link href="/insights" className="text-xs text-cream/45 transition hover:text-mint">Full market insights →</Link>
        </div>
        <LaunchTrend data={trend} />
      </section>

      {/* Recent launches + market pulse */}
      <section className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="rounded-2xl border border-cream/10 bg-cream/[0.02] p-5 md:p-6">
          <div className="mb-3 flex items-baseline justify-between">
            <h3 className="font-display text-lg text-cream">Just launched</h3>
            <Link href="/dashboard?launched=7d" className="text-xs text-cream/45 transition hover:text-mint">See all →</Link>
          </div>
          {launches.length === 0 ? (
            <p className="py-8 text-center text-sm text-cream/35">No fresh launches in the window yet.</p>
          ) : (
            <ul className="divide-y divide-cream/[0.06]">
              {launches.map((s) => (
                <li key={s.domain}>
                  <Link href={`/dashboard?q=${encodeURIComponent(s.domain)}`} className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-2.5 transition hover:bg-cream/[0.03]">
                    <span className="text-base">{s.country ? marketFlag(s.country) : "🌍"}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[13px] text-cream">{s.domain}</span>
                      <span className="mt-0.5 flex items-center gap-2 text-[11px] text-cream/40">
                        <span className={`rounded px-1.5 py-0.5 font-medium ${platTone(s.platform)}`}>{platName(s.platform)}</span>
                        {s.country ? cleanMarket(s.country) : ""}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-cream/40">{daysAgo(s.launchedAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-2xl border border-cream/10 bg-cream/[0.02] p-5 md:p-6">
          <div className="mb-4 flex items-baseline justify-between">
            <h3 className="font-display text-lg text-cream">Market pulse</h3>
            <Link href="/insights" className="text-xs text-cream/45 transition hover:text-mint">By country →</Link>
          </div>
          {markets.length === 0 ? (
            <p className="py-8 text-center text-sm text-cream/35">Market data is warming up.</p>
          ) : (
            <ul className="space-y-3">
              {markets.map((m) => (
                <li key={m.country}>
                  <Link href={`/dashboard?country=${m.country}`} className="block rounded-lg p-1 -m-1 transition hover:bg-cream/[0.03]">
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="text-cream/85">{marketFlag(m.country)} {cleanMarket(m.country)}</span>
                      <span className="shrink-0 font-mono text-xs text-cream/50">{m.live.toLocaleString()}{m.newWeek > 0 && <span className="ml-1.5 text-mint">+{m.newWeek}</span>}</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-cream/[0.06]"><div className="h-full rounded-full bg-gradient-to-r from-mint to-mint/40" style={{ width: `${Math.max(3, (100 * m.live) / marketMax)}%` }} /></div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Quick actions */}
      <section>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-cream/45">Jump back in</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <ActionCard href="/dashboard" title="Browse leads" desc="Filter the full store database and export your shortlist." />
          <ActionCard href="/insights" title="Market intelligence" desc="Payments, platforms and growth by country and technology." />
          <ActionCard href="/digests" title="Your digests" desc="The recurring briefings tailored to your goals." />
          {!org && <ActionCard href="/onboarding" title="Finish setup" desc="Tell Terrain who you target so we surface the right data." accent />}
        </div>
      </section>
    </div>
  );
}

function ReadPanel({ reads }: { reads: Read[] }) {
  const TONE: Record<string, { ic: string; cls: string; mag: string }> = {
    up: { ic: "⇡", cls: "bg-mint/15 text-mint", mag: "text-mint" },
    down: { ic: "⇣", cls: "bg-cream/10 text-cream/50", mag: "text-cream/50" },
    alert: { ic: "▲", cls: "bg-orange/15 text-orange", mag: "text-orange" },
  };
  return (
    <section className="rounded-2xl border border-cyan/20 bg-gradient-to-b from-cyan/[0.06] to-transparent p-5 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-display text-lg text-cream">
          <span className="grid h-6 w-6 place-items-center rounded-lg bg-cyan/15 text-xs text-cyan">✦</span> Terrain&apos;s read on the week
        </h3>
        <span className="font-mono text-[11px] text-cream/40">vs the prior 9 weeks</span>
      </div>
      <p className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-cream/45">
        <span className="text-mint">✓</span> Built on launch-dated cohorts — normalised for our scan volume, so an import week can&apos;t fake a trend.
      </p>
      {reads.length === 0 ? (
        <p className="mt-4 text-sm text-cream/55">Nothing unusual this week — new launches, platform mix and churn are all tracking their normal pace.</p>
      ) : (
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {reads.map((r) => {
            const t = TONE[r.tone] ?? TONE.up;
            return (
              <Link key={r.key} href={r.href} className="group flex items-center gap-3 rounded-xl border border-cream/10 bg-cream/[0.015] p-3 transition hover:border-cream/25 hover:bg-cream/[0.04]">
                <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-md text-xs ${t.cls}`}>{t.ic}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-semibold text-cream">{r.title}</span>
                  <span className="mt-0.5 block text-xs leading-snug text-cream/45">{r.detail}</span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <span className={`font-mono text-xs font-semibold ${t.mag}`}>{r.magnitude}</span>
                  <span className={`rounded-full px-1.5 py-0.5 font-mono text-[9px] ${r.confidence === "high" ? "bg-mint/15 text-mint" : "bg-orange-soft/15 text-orange-soft"}`}>{r.confidence}</span>
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ActionCard({ href, title, desc, accent }: { href: string; title: string; desc: string; accent?: boolean }) {
  return (
    <Link href={href}
      className={`group flex flex-col gap-1 rounded-2xl border p-4 transition ${accent ? "border-mint/30 bg-mint/[0.06] hover:bg-mint/10" : "border-cream/10 bg-cream/[0.02] hover:border-cream/25 hover:bg-cream/[0.04]"}`}>
      <div className="flex items-center justify-between">
        <span className="font-medium text-cream">{title}</span>
        <span className="font-mono text-cream/30 transition group-hover:translate-x-0.5 group-hover:text-cream/60">→</span>
      </div>
      <span className="text-xs leading-snug text-cream/50">{desc}</span>
    </Link>
  );
}
