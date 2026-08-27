import Link from "next/link";
import { redirect } from "next/navigation";
import { Wordmark } from "@/app/components/logo";
import { currentUser, isAdmin } from "@/lib/auth";
import { counts, listPending, aiEnrichmentStatus } from "@/lib/imported";
import { EnrichPanel } from "./enrich-panel";
import { AiStatusPanel } from "./ai-status";
import { BaselineReset } from "./baseline-reset";

export const metadata = { title: "Terrain — Admin" };
export const dynamic = "force-dynamic";

export default async function Admin() {
  const email = await currentUser();
  if (!email) redirect("/login");
  if (!isAdmin(email)) redirect("/dashboard");

  const c = await counts().catch(() => ({ pending: 0, published: 0 }));
  const pending = await listPending().catch(() => []);
  const aiStatus = await aiEnrichmentStatus().catch(() => null);
  const { AdminImport } = await import("./admin-import");

  return (
    <div className="min-h-screen px-4 py-6 md:px-8">
      <div className="mx-auto max-w-4xl">
        <nav className="flex items-center justify-between">
          <Link href="/"><Wordmark size="text-xl" /></Link>
          <div className="flex items-center gap-3 text-sm">
            <Link href="/admin/pending" className="text-cream/60 hover:text-cream">
              Review imports →
            </Link>
            <Link href="/admin/explore" className="text-cyan hover:underline">
              Leads Explorer →
            </Link>
            <Link href="/admin/stores" className="text-cream/60 hover:text-cream">
              Leads &amp; tags →
            </Link>
            <Link href="/admin/integrations" className="text-cream/60 hover:text-cream">
              Integrations →
            </Link>
            <Link href="/admin/churn" className="text-cream/60 hover:text-cream">
              Churn →
            </Link>
            <Link href="/admin/leads" className="text-cream/60 hover:text-cream">
              Edit leads →
            </Link>
            <Link href="/admin/subscribers" className="text-cream/60 hover:text-cream">
              Subscribers →
            </Link>
            <Link href="/admin/radar" className="text-cyan hover:underline">
              Radar detections →
            </Link>
            <span className="rounded-full border border-orange/30 bg-orange/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-orange">
              Admin
            </span>
          </div>
        </nav>

        <header className="mt-10">
          <h1 className="font-display text-4xl md:text-5xl">Import store base</h1>
          <p className="mt-2 text-cream/60">
            Upload a CSV of existing stores. They stay in a private pool until you
            publish them into the live feed.
          </p>
        </header>

        <AdminImport
          initialPending={c.pending}
          initialPublished={c.published}
          sample={pending}
        />

        {aiStatus && <AiStatusPanel status={aiStatus} />}
        <BaselineReset />
        <EnrichPanel />
      </div>
    </div>
  );
}
