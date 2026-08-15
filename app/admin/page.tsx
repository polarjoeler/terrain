import Link from "next/link";
import { redirect } from "next/navigation";
import { Wordmark } from "@/app/components/logo";
import { currentUser, isAdmin } from "@/lib/auth";
import { counts, listPending } from "@/lib/imported";
import { EnrichPanel } from "./enrich-panel";

export const metadata = { title: "Terrain — Admin" };
export const dynamic = "force-dynamic";

export default async function Admin() {
  const email = await currentUser();
  if (!email) redirect("/login");
  if (!isAdmin(email)) redirect("/dashboard");

  const c = await counts().catch(() => ({ pending: 0, published: 0 }));
  const pending = await listPending().catch(() => []);
  const { AdminImport } = await import("./admin-import");

  return (
    <div className="min-h-screen px-4 py-6 md:px-8">
      <div className="mx-auto max-w-4xl">
        <nav className="flex items-center justify-between">
          <Link href="/"><Wordmark size="text-xl" /></Link>
          <span className="rounded-full border border-orange/30 bg-orange/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-orange">
            Admin
          </span>
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

        <EnrichPanel />
      </div>
    </div>
  );
}
