import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Saved lists" };

export default async function ListsPage() {
  if (!(await currentUser())) redirect("/login");
  return (
    <div className="mx-auto max-w-3xl">
      <div className="rounded-3xl border border-cream/10 bg-cream/[0.02] p-8 text-center">
        <h2 className="font-display text-2xl text-cream">Saved lists</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-cream/55">
          Save a filtered set of stores from the Leads table and come back to it here — for a campaign,
          a territory, or a watchlist. List building is landing in an upcoming release.
        </p>
        <Link href="/dashboard" className="mt-5 inline-block rounded-full bg-mint px-5 py-2 text-sm font-semibold text-ink transition hover:brightness-105">
          Browse leads →
        </Link>
      </div>
    </div>
  );
}
