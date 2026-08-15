import Link from "next/link";
import { getAudit } from "@/lib/radar/audit";
import type { MatchReport, Verdict } from "@/lib/radar/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Launch promo — kept as constants so they're trivial to change.
const PROMO = { monthly: "R199", regular: "R499" };

const VERDICT_STYLE: Record<Verdict, { label: string; badge: string; icon: string }> = {
  COPY: { label: "Confirmed copy", badge: "bg-cyan text-cyan-deep", icon: "⛔" },
  LIKELY: { label: "Likely copy", badge: "bg-cyan/80 text-cyan-deep", icon: "⚠️" },
  PARTIAL: { label: "Partial match", badge: "bg-cream/15 text-cream", icon: "•" },
  clean: { label: "Clean", badge: "bg-cream/10 text-cream/60", icon: "" },
};

function MatchCard({ m }: { m: MatchReport }) {
  const v = VERDICT_STYLE[m.verdict];
  return (
    <div className="rounded-3xl border border-cyan/20 bg-cyan/[0.05] p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-cyan/15 pb-4">
        <div>
          <div className="font-mono text-cream">{m.suspect}</div>
          {m.suspectName && <div className="text-xs text-cream/45">{m.suspectName}</div>}
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded-full px-3 py-1 text-xs font-bold ${v.badge}`}>
            {v.label} · {m.score}
          </span>
        </div>
      </div>
      <ul className="mt-4 space-y-2 text-sm">
        {m.reasons.map((r, i) => (
          <li key={i} className="flex gap-2 text-cream/80">
            <span className="text-cyan">›</span>
            {r}
          </li>
        ))}
      </ul>
    </div>
  );
}

function MonitoringCTA({ brand, id }: { brand: string; id: string }) {
  const subject = encodeURIComponent(`Start Radar monitoring — ${brand}`);
  const body = encodeURIComponent(
    `I'd like to turn on real-time monitoring for ${brand}.\nAudit: ${id}`,
  );
  return (
    <div className="rounded-[2rem] bg-cyan p-8 text-center text-cyan-deep md:p-12">
      <h2 className="font-display text-3xl tracking-tight md:text-4xl">
        Catch the next one the day it launches.
      </h2>
      <p className="mx-auto mt-3 max-w-md text-cyan-deep/80">
        This audit is a snapshot of today. Monitoring watches for new clones
        24/7, preserves the evidence automatically, and alerts you the moment
        one appears.
      </p>
      <div className="mt-6 inline-flex items-baseline gap-2">
        <span className="font-display text-4xl">{PROMO.monthly}</span>
        <span className="text-cyan-deep/70">/mo</span>
        <span className="ml-2 rounded-full bg-cyan-deep/15 px-2 py-0.5 text-xs font-semibold">
          launch promo · then {PROMO.regular}
        </span>
      </div>
      <div className="mt-6">
        <a
          href={`mailto:hello@tembocommerce.com?subject=${subject}&body=${body}`}
          className="inline-block rounded-full bg-ink-deep px-7 py-3.5 font-medium text-cream transition hover:brightness-110"
        >
          Start monitoring {brand} →
        </a>
      </div>
    </div>
  );
}

export default async function AuditResultPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const audit = await getAudit(id);

  if (!audit) {
    return (
      <main className="mx-auto max-w-lg px-6 py-24 text-center">
        <h1 className="font-display text-3xl">Audit not found</h1>
        <p className="mt-3 text-cream/60">This scan may have expired or the link is wrong.</p>
        <Link href="/radar/scan" className="mt-6 inline-block text-cyan underline">
          Run a new audit →
        </Link>
      </main>
    );
  }

  const brand = audit.brandName || audit.brandDomain;

  if (audit.error) {
    return (
      <main className="mx-auto max-w-lg px-6 py-24 text-center">
        <h1 className="font-display text-3xl">We couldn&apos;t scan that store</h1>
        <p className="mt-4 text-cream/60">{audit.error}</p>
        <Link href="/radar/scan" className="mt-6 inline-block text-cyan underline">
          ← Try again
        </Link>
      </main>
    );
  }

  const copies = audit.matches.filter(
    (m) => m.verdict === "COPY" || m.verdict === "LIKELY",
  );
  const partials = audit.matches.filter((m) => m.verdict === "PARTIAL");
  const found = copies.length > 0;

  return (
    <main className="mx-auto max-w-3xl px-6 py-14">
      <Link href="/radar" className="text-sm text-cream/50 hover:text-cream">
        ← Radar
      </Link>

      {/* headline verdict */}
      <div className="mt-6 rounded-[2rem] border border-cream/12 p-8 text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cream/40">
          Brand audit · {audit.brandDomain}
        </p>
        {found ? (
          <>
            <h1 className="mt-4 font-display text-5xl tracking-tight text-cyan">
              {copies.length} {copies.length === 1 ? "store is" : "stores are"} copying you.
            </h1>
            <p className="mt-4 text-cream/60">
              We scanned your {audit.brandProducts.toLocaleString()}-product catalogue
              against {audit.candidates.toLocaleString()} {audit.market} store
              {audit.candidates === 1 ? "" : "s"} we track and found reproduced catalogues.
            </p>
          </>
        ) : (
          <>
            <h1 className="mt-4 font-display text-5xl tracking-tight">
              No clones found — today.
            </h1>
            <p className="mt-4 text-cream/60">
              We compared your {audit.brandProducts.toLocaleString()}-product catalogue
              against {audit.candidates.toLocaleString()} {audit.market} store
              {audit.candidates === 1 ? "" : "s"} we track and found no reproduced catalogues.
              {partials.length > 0 &&
                ` We did flag ${partials.length} partial match${partials.length === 1 ? "" : "es"} worth a look.`}
            </p>
          </>
        )}
      </div>

      {/* matches */}
      {audit.matches.length > 0 && (
        <div className="mt-8 space-y-4">
          {found && (
            <h2 className="text-sm font-semibold uppercase tracking-wide text-cream/50">
              The evidence
            </h2>
          )}
          {copies.map((m) => (
            <MatchCard key={m.suspect} m={m} />
          ))}
          {partials.length > 0 && (
            <>
              <h2 className="pt-2 text-sm font-semibold uppercase tracking-wide text-cream/50">
                Partial matches
              </h2>
              {partials.map((m) => (
                <MatchCard key={m.suspect} m={m} />
              ))}
            </>
          )}
        </div>
      )}

      {/* upsell */}
      <div className="mt-10">
        <MonitoringCTA brand={brand} id={audit.id} />
      </div>

      <p className="mt-8 text-center text-xs text-cream/40">
        Scanned against our known {audit.market} Shopify universe. Clones on
        unrelated domains are caught by continuous monitoring.
      </p>
    </main>
  );
}
