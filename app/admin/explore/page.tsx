import Link from "next/link";
import { redirect } from "next/navigation";
import { Wordmark } from "@/app/components/logo";
import { currentUser, isAdmin } from "@/lib/auth";
import { exploreLeads } from "@/lib/leads-explore";
import { Explorer } from "./explorer";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Leads Explorer" };

export default async function ExplorePage() {
  const email = await currentUser();
  if (!email) redirect("/login");
  if (!isAdmin(email)) redirect("/dashboard");

  const leads = await exploreLeads().catch(() => []);

  return (
    <div className="min-h-screen">
      <nav className="flex items-center justify-between border-b border-cream/10 px-5 py-3">
        <div className="flex items-center gap-3">
          <Link href="/"><Wordmark size="text-lg" /></Link>
          <span className="text-sm text-cream/45">· Leads Explorer</span>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <Link href="/admin" className="text-cream/60 hover:text-cream">← Admin</Link>
          <span className="rounded-full border border-orange/30 bg-orange/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-orange">Admin</span>
        </div>
      </nav>
      {leads.length === 0
        ? <p className="px-6 py-10 text-cream/50">No leads to explore yet.</p>
        : <Explorer leads={leads} />}
    </div>
  );
}
