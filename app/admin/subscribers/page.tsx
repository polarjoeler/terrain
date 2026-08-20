import Link from "next/link";
import { redirect } from "next/navigation";
import { Wordmark } from "@/app/components/logo";
import { currentUser, isAdmin } from "@/lib/auth";
import { listSubscribers } from "@/lib/subscriptions";
import { SubscribersTable } from "./subscribers-table";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Admin · Subscribers" };

export default async function AdminSubscribers() {
  const email = await currentUser();
  if (!email) redirect("/login");
  if (!isAdmin(email)) redirect("/dashboard");

  const subscribers = await listSubscribers().catch(() => []);
  const active = subscribers.filter((s) => s.status === "active" || s.status === "trialing").length;

  return (
    <div className="min-h-screen px-4 py-6 md:px-8">
      <div className="mx-auto max-w-5xl">
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
          <h1 className="font-display text-4xl md:text-5xl">Subscribers</h1>
          <p className="mt-2 text-cream/60">
            {subscribers.length.toLocaleString()} total · {active.toLocaleString()} with access.
            Grant a trial, comp access, or cancel — changes take effect immediately.
          </p>
        </header>

        <SubscribersTable initial={subscribers} />
      </div>
    </div>
  );
}
