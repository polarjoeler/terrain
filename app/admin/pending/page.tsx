import Link from "next/link";
import { redirect } from "next/navigation";
import { Wordmark } from "@/app/components/logo";
import { currentUser, isAdmin } from "@/lib/auth";
import { pendingStores, counts } from "@/lib/imported";
import { PendingReview } from "./pending-review";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Admin · Review imports" };

export default async function AdminPending() {
  const email = await currentUser();
  if (!email) redirect("/login");
  if (!isAdmin(email)) redirect("/dashboard");

  const [stores, c] = await Promise.all([
    pendingStores(1000).catch(() => []),
    counts().catch(() => ({ pending: 0, published: 0 })),
  ]);

  return (
    <div className="min-h-screen px-4 py-6 md:px-8">
      <div className="mx-auto max-w-6xl">
        <nav className="flex items-center justify-between">
          <Link href="/"><Wordmark size="text-xl" /></Link>
          <div className="flex items-center gap-3 text-sm">
            <Link href="/admin" className="text-cream/60 hover:text-cream">← Admin</Link>
            <Link href="/admin/leads" className="text-cream/60 hover:text-cream">Edit leads →</Link>
            <span className="rounded-full border border-orange/30 bg-orange/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-orange">
              Admin
            </span>
          </div>
        </nav>

        <header className="mt-10">
          <h1 className="font-display text-4xl md:text-5xl">Review imports</h1>
          <p className="mt-2 text-cream/60">
            {c.pending.toLocaleString()} pending · {c.published.toLocaleString()} already live.
            Inspect the batch, drop anything wrong, then publish what you keep — nothing
            reaches the feed until you publish it.
          </p>
        </header>

        {stores.length === 0 ? (
          <div className="mt-10 rounded-[2rem] border border-cream/12 p-8 text-center text-cream/60">
            Nothing pending review. Import a CSV or screenshots from the{" "}
            <Link href="/admin" className="text-cyan underline">Admin</Link> page.
          </div>
        ) : (
          <PendingReview initial={stores} />
        )}
      </div>
    </div>
  );
}
