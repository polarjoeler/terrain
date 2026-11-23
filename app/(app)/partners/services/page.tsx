import { redirect } from "next/navigation";
import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { servicePartners, type ServicePartner } from "@/lib/service-partners";
import { countryCode } from "@/lib/partner-directory";
import { CountryBar, Tabs, SearchBox, hrefWith, flag, marketName } from "../filters";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Service Partners" };

const CUR: Record<string, string> = { ZAR: "R", USD: "$", NGN: "₦", KES: "KSh", GHS: "₵", EUR: "€", GBP: "£" };
const budget = (p: ServicePartner) =>
  p.startingPrice && p.startingPrice > 0 ? `from ${CUR[p.currency ?? ""] ?? (p.currency ? p.currency + " " : "")}${p.startingPrice.toLocaleString()}` : "On request";

function Chips({ items, tone = "text-cream/55", max = 3 }: { items: string[]; tone?: string; max?: number }) {
  if (!items.length) return <span className="text-cream/25">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {items.slice(0, max).map((s) => <span key={s} className={`rounded-full border border-cream/12 px-2 py-0.5 text-[10px] ${tone}`}>{s}</span>)}
      {items.length > max && <span className="text-[10px] text-cream/30">+{items.length - max}</span>}
    </span>
  );
}

function PartnerCard({ p, showCountry }: { p: ServicePartner; showCountry: boolean }) {
  const cc = countryCode(p.country);
  return (
    <div className="flex flex-col rounded-2xl border border-cream/12 bg-cream/[0.02] p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-cream/90">
            {p.websiteUrl ? <a href={p.websiteUrl} target="_blank" rel="noopener noreferrer" className="hover:text-cyan hover:underline">{p.name}</a> : p.name}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-cream/40">
            {[p.type, p.location ?? (showCountry && cc ? marketName(cc) : null)].filter(Boolean).join(" · ") || " "}
            {showCountry && cc && <span className="ml-1">{flag(cc)}</span>}
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          {p.isPro && <span className="rounded-full border border-mint/30 bg-mint/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-mint">Pro</span>}
          {p.verified
            ? <span className="rounded-full border border-cyan/25 bg-cyan/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-cyan" title="Listed on Africa Shop Experts">Verified</span>
            : <span className="rounded-full border border-cream/15 bg-cream/[0.04] px-1.5 py-0.5 text-[9px] font-semibold uppercase text-cream/45" title="Discovered by Terrain from a public build credit — unclaimed">Discovered</span>}
        </div>
      </div>

      <div className="mb-3 mt-3 space-y-1.5 text-[11px]">
        {p.services.length > 0 && <div><Chips items={p.services} tone="text-cyan/75" /></div>}
        {p.partnerPrograms.length > 0 && <div><Chips items={p.partnerPrograms} tone="text-mint/70" max={2} /></div>}
        {p.skills.length > 0 && <div><Chips items={p.skills} tone="text-lilac/70" /></div>}
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-cream/[0.06] pt-3 text-xs tabular-nums">
        <span className="text-cream/70">{budget(p)}</span>
        <span className="text-cream/50">
          {p.rating ? <span className="text-cream/85">★ {p.rating.toFixed(1)}</span> : null}
          {p.completedProjects ? <span className="ml-2">{p.completedProjects} projects</span> : null}
          {p.storesLinked != null && <span className="ml-2">{p.storesLinked.toLocaleString()} stores</span>}
        </span>
      </div>
    </div>
  );
}

export default async function ServicePartnersPage({
  searchParams,
}: {
  searchParams: Promise<{ country?: string; focus?: string; q?: string }>;
}) {
  const email = await currentUser();
  if (!email) redirect("/login");

  const sp = await searchParams;
  const all = await servicePartners();
  const base = "/partners/services";

  // Country counts (service partners store a country NAME; unplaced ones become "other").
  const keyOf = (p: ServicePartner) => countryCode(p.country) ?? "other";
  const byCountry = new Map<string, number>();
  for (const p of all) byCountry.set(keyOf(p), (byCountry.get(keyOf(p)) ?? 0) + 1);
  const countries = [...byCountry.entries()]
    .sort((a, b) => (a[0] === "other" ? 1 : b[0] === "other" ? -1 : b[1] - a[1]))
    .map(([code, count]) => ({ code, count, label: code === "other" ? "Pan-African / unplaced" : undefined }));

  const cc = sp.country === "other" ? "other" : sp.country?.toUpperCase();
  const country = cc && byCountry.has(cc) ? cc : undefined;
  const inCountry = country ? all.filter((p) => keyOf(p) === country) : all;

  // Platform focus tabs from what's actually in this market.
  const focusCount = new Map<string, number>();
  for (const p of inCountry) for (const s of p.services) focusCount.set(s, (focusCount.get(s) ?? 0) + 1);
  const focuses = [...focusCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const focus = sp.focus && focusCount.has(sp.focus) ? sp.focus : undefined;

  const q = sp.q?.trim().toLowerCase() ?? "";
  const cur = { country, focus, q: q || undefined };
  const rows = inCountry
    .filter((p) => !focus || p.services.includes(focus))
    .filter((p) => !q || [p.name, p.type, p.location, ...p.services, ...p.skills, ...p.partnerPrograms].some((s) => s?.toLowerCase().includes(q)));

  const where = !country ? "Africa" : country === "other" ? "pan-African / unplaced" : `${flag(country)} ${marketName(country)}`;

  return (
    <div className="mx-auto max-w-5xl">
      <Link href="/partners" className="text-xs text-cream/40 hover:text-cream">← Partner Finder</Link>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl text-cream">Service Partners</h1>
          <p className="mt-1 max-w-2xl text-xs text-cream/45">
            The agencies &amp; pros building stores in {where} — who to approach for go-to-market through this channel.
            Synced from Africa Shop Experts, plus builders Terrain discovered from public credits.
          </p>
        </div>
        <Link href="/partners/products" className="shrink-0 rounded-full border border-cream/15 px-3 py-1 text-sm text-cream/60 hover:text-cream">Product Partners →</Link>
      </div>

      {all.length === 0 ? (
        <p className="mt-8 text-cream/50">No service partners synced yet — run <code className="text-cream/60">scripts/sync-experts.mjs</code>.</p>
      ) : (
        <>
          <div className="mt-5">
            <CountryBar base={base} cur={{ ...cur, focus: undefined }} countries={countries} allCount={all.length} />
          </div>

          <div className="mt-5 flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0 flex-1">
              <Tabs items={[
                { key: "all", label: "All", count: inCountry.length, href: hrefWith(base, cur, { focus: null }), on: !focus },
                ...focuses.map(([f, n]) => ({ key: f, label: f, count: n, href: hrefWith(base, cur, { focus: f }), on: f === focus })),
              ]} />
            </div>
            <SearchBox base={base} cur={cur} placeholder="Search name, skill, program…" />
          </div>

          <p className="mt-3 text-[11px] text-cream/40">{rows.length.toLocaleString()} partner{rows.length === 1 ? "" : "s"}</p>

          {rows.length === 0 ? (
            <p className="mt-6 text-sm text-cream/50">No partners match these filters.</p>
          ) : (
            <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {rows.map((p) => <PartnerCard key={p.id} p={p} showCountry={!country} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
