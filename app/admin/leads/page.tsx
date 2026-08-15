import Link from "next/link";
import { redirect } from "next/navigation";
import { Wordmark } from "@/app/components/logo";
import { currentUser, isAdmin } from "@/lib/auth";
import { LeadEditor } from "./lead-editor";

export const metadata = { title: "Terrain — Edit leads" };
export const dynamic = "force-dynamic";

export default async function EditLeads() {
  const email = await currentUser();
  if (!email) redirect("/login");
  if (!isAdmin(email)) redirect("/dashboard");

  return (
    <div className="min-h-screen px-4 py-6 md:px-8">
      <div className="mx-auto max-w-4xl">
        <nav className="flex items-center justify-between">
          <Link href="/"><Wordmark size="text-xl" /></Link>
          <div className="flex items-center gap-3 text-sm">
            <Link href="/admin" className="text-cream/50 hover:text-cream">Import</Link>
            <span className="rounded-full border border-orange/30 bg-orange/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-orange">
              Edit leads
            </span>
          </div>
        </nav>

        <header className="mt-10">
          <h1 className="font-display text-4xl md:text-5xl">Correct a lead</h1>
          <p className="mt-2 max-w-xl text-cream/60">
            Spotted an error? Load the store, fix the fields, save. The correction
            is stored as an override that wins over every source and survives the
            pipeline re-enriching — unlike editing the Sheet directly.
          </p>
        </header>

        <LeadEditor />
      </div>
    </div>
  );
}
