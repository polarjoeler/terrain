import { redirect } from "next/navigation";
import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { servicePartners, type ServicePartner } from "@/lib/service-partners";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Service Partners" };

const FLAG: Record<string, string> = { "South Africa": "🇿🇦", Nigeria: "🇳🇬", Kenya: "🇰🇪", Ghana: "🇬🇭", Egypt: "🇪🇬" };
const CUR: Record<string, string> = { ZAR: "R", USD: "$", NGN: "₦", KES: "KSh", GHS: "₵", EUR: "€", GBP: "£" };
const budget = (p: ServicePartner) =>
  p.startingPrice && p.startingPrice > 0 ? `from ${CUR[p.currency ?? ""] ?? (p.currency ? p.currency + " " : "")}${p.startingPrice.toLocaleString()}` : "On request";

function Chips({ items, tone = "text-cream/55" }: { items: string[]; tone?: string }) {
  if (!items.length) return <span className="text-cream/25">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {items.slice(0, 3).map((s) => <span key={s} className={`rounded-full border border-cream/12 px-2 py-0.5 text-[10px] ${tone}`}>{s}</span>)}
      {items.length > 3 && <span className="text-[10px] text-cream/30">+{items.length - 3}</span>}
    </span>
  );
}

function PartnerRow({ p }: { p: ServicePartner }) {
  return (
    <tr className="border-b border-cream/[0.06] align-top">
      <td className="py-3 pl-3 pr-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-cream/90">{p.websiteUrl ? <a href={p.websiteUrl} target="_blank" rel="noopener noreferrer" className="hover:text-cyan hover:underline">{p.name}</a> : p.name}</span>
          {p.isPro && <span className="rounded-full border border-mint/30 bg-mint/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-mint">Pro</span>}
          {p.verified
            ? <span className="rounded-full border border-cyan/25 bg-cyan/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-cyan" title="Listed on Africa Shop Experts">Verified</span>
            : <span className="rounded-full border border-cream/15 bg-cream/[0.04] px-1.5 py-0.5 text-[9px] font-semibold uppercase text-cream/45" title="Discovered by Terrain from a public build credit — unclaimed">Discovered</span>}
        </div>
        <div className="mt-0.5 text-[11px] text-cream/40">{p.type}{p.location ? ` · ${p.location}` : ""}</div>
        {p.skills.length > 0 && <div className="mt-1.5"><Chips items={p.skills} tone="text-lilac/70" /></div>}
      </td>
      <td className="py-3 pr-3"><Chips items={p.services} tone="text-cyan/75" /></td>
      <td className="py-3 pr-3"><Chips items={p.partnerPrograms} tone="text-mint/70" /></td>
      <td className="py-3 pr-3 text-right text-sm tabular-nums">
        {p.rating != null ? <span className="text-cream/85">★ {p.rating.toFixed(1)}</span> : <span className="text-cream/25">—</span>}
        {p.completedProjects != null && p.completedProjects > 0 && <div className="text-[10px] text-cream/35">{p.completedProjects} projects</div>}
      </td>
      <td className="py-3 pr-3 text-right text-xs tabular-nums text-cream/70 whitespace-nowrap">{budget(p)}</td>
      <td className="py-3 pr-4 text-right text-sm tabular-nums">
        {p.storesLinked != null ? <span className="text-cream/85">{p.storesLinked.toLocaleString()}</span> : <span className="text-cream/25" title="Store attribution coming — matching partners to the stores they've built">soon</span>}
      </td>
    </tr>
  );
}

export default async function ServicePartnersPage() {
  const email = await currentUser();
  if (!email) redirect("/login");

  const partners = await servicePartners();
  const byCountry = new Map<string, ServicePartner[]>();
  for (const p of partners) {
    const c = p.country ?? "Other";
    (byCountry.get(c) ?? byCountry.set(c, []).get(c)!).push(p);
  }
  const countries = [...byCountry.entries()].sort((a, b) => b[1].length - a[1].length);

  return (
    <main className="min-h-screen px-4 py-6">
      <div className="mx-auto max-w-5xl">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-display text-2xl text-cream">Service Partners</h1>
            <p className="mt-1 max-w-2xl text-xs text-cream/45">
              The agencies &amp; pros building stores across Africa — who to approach for GTM through this channel.
              Synced from Africa Shop Experts. <b className="text-cream/60">Stores linked</b> (which stores each partner built) is being attributed from our crawl.
            </p>
          </div>
          <Link href="/partners" className="shrink-0 rounded-full border border-cream/15 px-3 py-1 text-sm text-cream/60 hover:text-cream">Product Partners →</Link>
        </div>

        {partners.length === 0 && <p className="mt-8 text-cream/50">No service partners synced yet — run <code className="text-cream/60">scripts/sync-experts.mjs</code>.</p>}

        {countries.map(([country, rows]) => (
          <section key={country} className="mt-6">
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-cream/70">{FLAG[country] ?? "🌍"} {country}</h2>
              <span className="text-[11px] text-cream/35">{rows.length} partners</span>
            </div>
            <div className="overflow-x-auto rounded-2xl border border-cream/12 bg-cream/[0.02]">
              <table className="w-full min-w-[820px] border-collapse">
                <thead>
                  <tr className="border-b border-cream/12 text-[10px] font-semibold uppercase tracking-wide text-cream/40">
                    <th className="py-2 pl-3 pr-3 text-left">Partner &amp; differentiators</th>
                    <th className="py-2 pr-3 text-left">Platform focus</th>
                    <th className="py-2 pr-3 text-left">Partner programs</th>
                    <th className="py-2 pr-3 text-right">Reviews</th>
                    <th className="py-2 pr-3 text-right">Budget</th>
                    <th className="py-2 pr-4 text-right">Stores</th>
                  </tr>
                </thead>
                <tbody>{rows.map((p) => <PartnerRow key={p.id} p={p} />)}</tbody>
              </table>
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
