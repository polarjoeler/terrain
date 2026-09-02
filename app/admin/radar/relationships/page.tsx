import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser, isAdmin } from "@/lib/auth";
import { listRelationships, relationshipCounts, REVIEW_REASONS } from "@/lib/radar/relationships";
import { RelationshipsView } from "./relationships-view";

export const metadata = { title: "Radar — Review suppressed pairs" };
export const dynamic = "force-dynamic";

export default async function ReviewRelationships({
  searchParams,
}: { searchParams: Promise<{ reason?: string; unlabelled?: string }> }) {
  const email = await currentUser();
  if (!email) redirect("/login");
  if (!isAdmin(email)) redirect("/dashboard");

  const sp = await searchParams;
  const counts = await relationshipCounts().catch(() => []);
  const reason = sp.reason && counts.some((c) => c.reason === sp.reason) ? sp.reason : undefined;
  const onlyUnlabelled = sp.unlabelled === "1";
  const rows = await listRelationships({ reason, onlyUnlabelled, limit: 150 }).catch(() => []);

  const reviewable = counts.filter((c) => REVIEW_REASONS.includes(c.reason));
  const totalLabelled = counts.reduce((a, c) => a + c.labelled, 0);

  return (
    <div className="min-h-screen bg-[#0b0e10] px-4 py-6 md:px-8">
      <div className="mx-auto max-w-5xl">
        <nav className="flex items-center justify-between">
          <Link href="/radar" className="text-xl font-semibold tracking-tight text-cream">◎ Radar</Link>
          <div className="flex items-center gap-3 text-sm">
            <Link href="/admin/radar" className="text-cream/50 hover:text-cream">← Detections</Link>
            <Link href="/admin/radar/fraud" className="text-orange hover:underline">Market fraud →</Link>
          </div>
        </nav>

        <header className="mt-10">
          <h1 className="font-display text-4xl md:text-5xl">Review suppressed pairs</h1>
          <p className="mt-2 max-w-2xl text-cream/60">
            Stores that share a catalogue but weren&apos;t reported as impersonation, and why.
            Labelling these is what lets the clone scoring be tuned against your judgement
            rather than mine — right now nothing in the data is labelled.
          </p>
          <p className="mt-2 text-sm text-cream/40">
            {totalLabelled} labelled so far. <span className="text-cream/30">weak-overlap is hidden by default — those pairs barely share a catalogue, so a wrong call there costs nothing.</span>
          </p>
        </header>

        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Link href="/admin/radar/relationships" className={`rounded-full px-3.5 py-1.5 text-sm ${!reason ? "bg-cream text-ink" : "border border-cream/15 text-cream/60"}`}>
            Review queue
          </Link>
          {reviewable.map((c) => (
            <Link key={c.reason} href={`/admin/radar/relationships?reason=${c.reason}`}
              className={`rounded-full px-3.5 py-1.5 text-sm ${reason === c.reason ? "bg-cream text-ink" : "border border-cream/15 text-cream/60"}`}>
              {c.reason} {c.total}{c.labelled ? ` · ${c.labelled}✓` : ""}
            </Link>
          ))}
          <Link href={`/admin/radar/relationships?${new URLSearchParams({ ...(reason ? { reason } : {}), ...(onlyUnlabelled ? {} : { unlabelled: "1" }) })}`}
            className={`ml-auto rounded-full px-3.5 py-1.5 text-sm ${onlyUnlabelled ? "bg-cyan text-cyan-deep" : "border border-cream/15 text-cream/60"}`}>
            {onlyUnlabelled ? "✓ Unlabelled only" : "Unlabelled only"}
          </Link>
        </div>

        {rows.length === 0 ? (
          <p className="mt-10 rounded-2xl border border-cream/12 p-6 text-sm text-cream/50">
            Nothing to review here. Run the sweep, or clear the filters.
          </p>
        ) : (
          <RelationshipsView rows={rows} />
        )}
      </div>
    </div>
  );
}
