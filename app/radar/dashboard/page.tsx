import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { brandsForEmail, hasActiveMonitoring, type BrandAccount } from "@/lib/radar/brands";
import { detectionsForBrands, type Detection } from "@/lib/radar/audit";
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

function ActiveBrand({ brand, detections }: { brand: BrandAccount; detections: Detection[] }) {
  return (
    <section className="rounded-[2rem] border border-cream/12 p-6 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl text-cream">{brand.brandName || brand.brandDomain}</h2>
          <p className="text-sm text-cream/45">{brand.brandDomain} · {brand.market}</p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-mint/25 bg-mint/10 px-3 py-1 text-xs font-semibold text-mint">
          <span className="h-1.5 w-1.5 rounded-full bg-mint" /> Monitoring active
        </span>
      </div>
      <div className="mt-6">
        {detections.length ? (
          <>
            <p className="mb-3 text-sm text-cream/60">
              {detections.length} store{detections.length === 1 ? "" : "s"} reproducing your catalogue:
            </p>
            <div className="space-y-3">
              {detections.map((d) => <DetectionCard key={`${d.brandDomain}-${d.suspect}`} d={d} />)}
            </div>
          </>
        ) : (
          <div className="rounded-2xl border border-cream/12 p-6 text-sm text-cream/55">
            <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-mint align-middle" />
            No clones detected yet — Radar is watching every new store against your catalogue 24/7.
            We&apos;ll alert you the moment one appears.
          </div>
        )}
      </div>
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
  const all = active.length ? await detectionsForBrands(active.map((b) => b.brandDomain)) : [];
  const byBrand = new Map<string, Detection[]>();
  for (const d of all) {
    const arr = byBrand.get(d.brandDomain) ?? [];
    arr.push(d);
    byBrand.set(d.brandDomain, arr);
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
                <ActiveBrand key={b.brandDomain} brand={b} detections={byBrand.get(b.brandDomain) ?? []} />
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
