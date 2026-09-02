import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { brandsForEmail, hasActiveMonitoring, type BrandAccount } from "@/lib/radar/brands";
import { detectionsForBrands, type Detection } from "@/lib/radar/audit";
import { lastRun } from "@/lib/radar/fraud-sweep";
import {
  domainWatchesForBrands,
  domainWatchLastRun,
  emailPosture,
  kindLabel,
  watchRisk,
  type DomainWatch,
} from "@/lib/radar/domains";
import { SubscribeButton } from "../subscribe-button";
import type { Verdict } from "@/lib/radar/catalog";

export const metadata = { title: "Radar — Your monitoring" };
export const dynamic = "force-dynamic";

const PROMO = "R199";

const VERDICT: Record<Verdict, { label: string; badge: string }> = {
  COPY: { label: "Confirmed copy", badge: "bg-cyan text-cyan-deep" },
  LIKELY: { label: "Likely copy", badge: "bg-cyan/70 text-cyan-deep" },
  PARTIAL: { label: "Partial match", badge: "bg-cream/15 text-cream" },
  clean: { label: "Clean", badge: "bg-cream/10 text-cream/50" },
};

function ago(iso: string) {
  const d = (Date.now() - new Date(iso).getTime()) / 864e5;
  if (d < 1) return "today";
  if (d < 2) return "yesterday";
  if (d < 30) return `${Math.floor(d)}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** How long ago a sweep ran, to the hour — "2h ago" reassures in a way that
 *  "today" doesn't, which is the whole point of showing it on a monitoring page. */
function sweptAgo(iso: string | null | undefined) {
  if (!iso) return "not yet run";
  const mins = (Date.now() - new Date(iso).getTime()) / 6e4;
  if (mins < 2) return "just now";
  if (mins < 60) return `${Math.floor(mins)}m ago`;
  if (mins < 48 * 60) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}
const exact = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "never run";

function DetectionCard({ d }: { d: Detection }) {
  const v = VERDICT[d.verdict];
  return (
    <div className="rounded-2xl border border-cyan/20 bg-cyan/[0.04] p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 font-mono text-cream">{d.suspect}</div>
        <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-bold ${v.badge}`}>
          {v.label} · {d.score}
        </span>
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-cream/55">
        {d.reasons.slice(0, 3).map((r, i) => <li key={i}>› {r}</li>)}
      </ul>
      <div className="mt-3 flex items-center justify-between text-xs">
        <span className="text-cream/40">first seen {ago(d.at)}</span>
        <Link
          href={`/radar/dossier/${encodeURIComponent(d.brandDomain)}/${encodeURIComponent(d.suspect)}`}
          className="font-medium text-cyan hover:underline"
        >
          Prepare takedown →
        </Link>
      </div>
    </div>
  );
}

const RISK: Record<"high" | "medium" | "low", string> = {
  high: "bg-orange/20 text-orange",
  medium: "bg-cyan/15 text-cyan",
  low: "bg-cream/10 text-cream/50",
};

function SectionHead({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-cream/40">
      {children}
      {count != null && count > 0 && (
        <span className="rounded-full bg-cream/10 px-2 py-0.5 text-[0.65rem] text-cream/60">{count}</span>
      )}
    </h3>
  );
}

function LookalikeCard({ w }: { w: DomainWatch }) {
  const risk = watchRisk(w);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-cream/10 bg-cream/[0.02] px-4 py-3">
      <div className="min-w-0">
        <div className="font-mono text-sm text-cream">{w.lookalike}</div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[0.7rem] text-cream/40">
          <span>{kindLabel(w.kind)}</span>
          {w.hasSite && <span>› live site</span>}
          {w.hasMail && <span>› sends email</span>}
        </div>
      </div>
      <span className={`shrink-0 rounded-full px-2.5 py-1 text-[0.65rem] font-bold uppercase ${RISK[risk]}`}>
        {risk === "high" ? "Phishing risk" : risk === "medium" ? "Active" : "Watch"}
      </span>
    </div>
  );
}

function EmailProtection({ brand }: { brand: BrandAccount }) {
  const p = emailPosture(brand);
  if (!p.checkedAt) return null;
  const chip = (ok: boolean, label: string) => (
    <span className={`rounded-full px-2.5 py-1 text-[0.65rem] font-semibold ${ok ? "bg-mint/15 text-mint" : "bg-orange/20 text-orange"}`}>
      {label}
    </span>
  );
  return (
    <div className="mt-8">
      <SectionHead>Email spoofing protection</SectionHead>
      <div className={`rounded-2xl border p-5 ${p.spoofable ? "border-orange/25 bg-orange/[0.05]" : "border-mint/20 bg-mint/[0.04]"}`}>
        <div className="flex flex-wrap items-center gap-2">
          {chip(!!p.spfPresent, p.spfPresent ? "SPF set" : "SPF missing")}
          {chip(!p.spoofable && p.dmarcPolicy != null && p.dmarcPolicy !== "none",
            p.dmarcPolicy == null ? "DMARC missing" : `DMARC p=${p.dmarcPolicy}`)}
        </div>
        <p className="mt-3 text-sm text-cream/70">{p.summary}</p>
        {p.spoofable && (
          <p className="mt-2 text-xs text-cream/45">
            Fix: publish a DMARC record at <span className="font-mono">_dmarc.{brand.brandDomain}</span> with{" "}
            <span className="font-mono">p=quarantine</span> or <span className="font-mono">p=reject</span> once your SPF/DKIM are in place.
          </p>
        )}
      </div>
    </div>
  );
}

function ActiveBrand({
  brand,
  detections,
  watches,
  cloneSweptAt,
  domainSweptAt,
}: {
  brand: BrandAccount;
  detections: Detection[];
  watches: DomainWatch[];
  cloneSweptAt: string | null;
  domainSweptAt: string | null;
}) {
  const mailers = watches.filter((w) => w.hasMail).length;
  return (
    <section className="rounded-[2rem] border border-cream/12 p-6 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl text-cream">{brand.brandName || brand.brandDomain}</h2>
          <p className="text-sm text-cream/45">{brand.brandDomain} · {brand.market}</p>
        </div>
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-mint/25 bg-mint/10 px-3 py-1 text-xs font-semibold text-mint">
            <span className="h-1.5 w-1.5 rounded-full bg-mint" /> Monitoring active
          </span>
          {/* Two separate jobs cover this brand and they run on their own cadences,
              so they're reported separately — one combined "last swept" would be
              wrong for whichever ran less recently. */}
          <span className="text-[11px] text-cream/40">
            <span title={`Clone sweep: ${exact(cloneSweptAt)}`}>clone sweep {sweptAgo(cloneSweptAt)}</span>
            <span className="text-cream/20"> · </span>
            <span title={`Domain watch: ${exact(domainSweptAt)}`}>domain watch {sweptAgo(domainSweptAt)}</span>
          </span>
        </div>
      </div>

      {/* Catalogue clones */}
      <div className="mt-6">
        <SectionHead count={detections.length}>Catalogue clones</SectionHead>
        {detections.length ? (
          <div className="space-y-3">
            {detections.map((d) => <DetectionCard key={`${d.brandDomain}-${d.suspect}`} d={d} />)}
          </div>
        ) : (
          <div className="rounded-2xl border border-cream/12 p-6 text-sm text-cream/55">
            <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-mint align-middle" />
            No clones detected yet — Radar is watching every new store against your catalogue 24/7.
            We&apos;ll alert you the moment one appears.
          </div>
        )}
      </div>

      {/* Look-alike domains */}
      <div className="mt-8">
        <SectionHead count={watches.length}>Look-alike domains</SectionHead>
        {watches.length ? (
          <>
            <p className="mb-3 text-sm text-cream/60">
              {watches.length} registered domain{watches.length === 1 ? "" : "s"} imitate{watches.length === 1 ? "s" : ""} yours
              {mailers > 0 && <> — <span className="text-orange">{mailers} can send email as you</span></>}.
            </p>
            <div className="space-y-2">
              {watches.slice(0, 15).map((w) => <LookalikeCard key={w.lookalike} w={w} />)}
            </div>
            {watches.length > 15 && (
              <p className="mt-3 text-xs text-cream/40">+ {watches.length - 15} more being watched.</p>
            )}
          </>
        ) : (
          <div className="rounded-2xl border border-cream/12 p-6 text-sm text-cream/55">
            <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-mint align-middle" />
            No look-alike domains registered against you. Radar sweeps typo, homoglyph and
            wrong-TLD variants of {brand.brandDomain} and flags any that go live.
          </div>
        )}
      </div>

      {/* Email spoofing posture */}
      <EmailProtection brand={brand} />
    </section>
  );
}

function LockedBrand({ brand, email }: { brand: BrandAccount; email: string }) {
  return (
    <section className="rounded-[2rem] border border-cream/12 bg-cream/[0.02] p-6 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl text-cream">{brand.brandName || brand.brandDomain}</h2>
          <p className="text-sm text-cream/45">{brand.brandDomain} · {brand.market}</p>
        </div>
        <span className="rounded-full border border-cream/20 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-cream/50">
          Not monitored
        </span>
      </div>
      <p className="mt-5 max-w-md text-sm text-cream/55">
        Your fingerprint is on file. Turn on monitoring to see clones as they appear,
        get alerted, and pull takedown evidence — {PROMO}/mo, cancel anytime.
      </p>
      <div className="mt-5">
        <SubscribeButton brandDomain={brand.brandDomain} email={email} label={`Start monitoring — ${PROMO}/mo`} />
      </div>
    </section>
  );
}

export default async function RadarDashboard() {
  const email = await currentUser();
  if (!email) redirect("/login");

  const brands = await brandsForEmail(email);
  const active = brands.filter((b) => hasActiveMonitoring(b.status));
  const activeDomains = active.map((b) => b.brandDomain);
  const [all, allWatches] = activeDomains.length
    ? await Promise.all([detectionsForBrands(activeDomains), domainWatchesForBrands(activeDomains)])
    : [[] as Detection[], [] as DomainWatch[]];
  // When each job last looked. The clone sweep is market-wide (one timestamp for
  // everyone); the domain watch is per-brand, derived from its own rows.
  const [cloneRun, domainRuns] = await Promise.all([
    lastRun("fraud").catch(() => null),
    activeDomains.length ? domainWatchLastRun(activeDomains).catch(() => new Map<string, string>()) : Promise.resolve(new Map<string, string>()),
  ]);
  const byBrand = new Map<string, Detection[]>();
  for (const d of all) {
    const arr = byBrand.get(d.brandDomain) ?? [];
    arr.push(d);
    byBrand.set(d.brandDomain, arr);
  }
  const watchesByBrand = new Map<string, DomainWatch[]>();
  for (const w of allWatches) {
    const arr = watchesByBrand.get(w.brandDomain) ?? [];
    arr.push(w);
    watchesByBrand.set(w.brandDomain, arr);
  }

  return (
    <div className="min-h-screen px-4 py-6 md:px-8">
      <div className="mx-auto max-w-4xl">
        <nav className="flex items-center justify-between">
          <Link href="/radar" className="flex items-center gap-2 text-cream">
            <span className="text-xl font-semibold tracking-tight">◎ Radar</span>
          </Link>
          <form action="/api/auth/signout" method="post">
            <button className="text-sm text-cream/50 hover:text-cream" type="submit">Sign out</button>
          </form>
        </nav>

        <header className="mt-10">
          <h1 className="font-display text-4xl md:text-5xl text-cream">Your brand protection</h1>
          <p className="mt-2 text-cream/60">Signed in as {email}</p>
        </header>

        {brands.length === 0 ? (
          <div className="mt-10 rounded-[2rem] border border-cream/12 p-8 text-center">
            <p className="text-cream/60">You haven&apos;t run a brand audit yet.</p>
            <Link href="/radar/scan" className="mt-4 inline-block rounded-full bg-cyan px-6 py-3 text-sm font-medium text-cyan-deep transition hover:brightness-110">
              Run a free brand audit →
            </Link>
          </div>
        ) : (
          <div className="mt-8 space-y-5">
            {brands.map((b) =>
              hasActiveMonitoring(b.status) ? (
                <ActiveBrand
                  key={b.brandDomain}
                  brand={b}
                  detections={byBrand.get(b.brandDomain) ?? []}
                  watches={watchesByBrand.get(b.brandDomain) ?? []}
                  cloneSweptAt={cloneRun?.ranAt ?? null}
                  domainSweptAt={domainRuns.get(b.brandDomain) ?? null}
                />
              ) : (
                <LockedBrand key={b.brandDomain} brand={b} email={email} />
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}
