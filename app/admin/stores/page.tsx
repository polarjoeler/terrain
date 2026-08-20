import Link from "next/link";
import { redirect } from "next/navigation";
import { Wordmark } from "@/app/components/logo";
import { currentUser, isAdmin } from "@/lib/auth";
import { managerStores } from "@/lib/imported";
import { tagsForDomains, tagCounts, PRESET_TAGS } from "@/lib/tags";
import { availableCountries } from "@/lib/insights";
import { StoresManager } from "./stores-manager";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Admin · Leads & tags" };

export default async function AdminStores() {
  const email = await currentUser();
  if (!email) redirect("/login");
  if (!isAdmin(email)) redirect("/dashboard");

  const stores = await managerStores().catch(() => []);
  const [tags, counts, countries] = await Promise.all([
    tagsForDomains(stores.map((s) => s.domain)).catch(() => ({}) as Record<string, string[]>),
    tagCounts().catch(() => []),
    availableCountries().catch(() => []),
  ]);
  const withTags = stores.map((s) => ({ ...s, tags: tags[s.domain] ?? [] }));

  return (
    <div className="min-h-screen px-4 py-6 md:px-8">
      <div className="mx-auto max-w-6xl">
        <nav className="flex items-center justify-between">
          <Link href="/"><Wordmark size="text-xl" /></Link>
          <div className="flex items-center gap-3 text-sm">
            <Link href="/admin" className="text-cream/60 hover:text-cream">← Admin</Link>
            <Link href="/insights" className="text-cream/60 hover:text-cream">Insights →</Link>
            <span className="rounded-full border border-orange/30 bg-orange/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-orange">Admin</span>
          </div>
        </nav>

        <header className="mt-10">
          <h1 className="font-display text-4xl md:text-5xl">Leads &amp; tags</h1>
          <p className="mt-2 text-cream/60">
            {stores.length.toLocaleString()} live stores. Tag your cohorts — curate the{" "}
            <b>Top 100 / Top 1000</b> per market, mark <b>Partner Managed</b> — then view a
            tagged breakdown in <Link href="/insights" className="text-cyan underline">Insights</Link>.
          </p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-cream/50">
            {counts.map((c) => (
              <span key={c.tag} className="rounded-full border border-cream/12 px-3 py-1">
                {PRESET_TAGS.find((p) => p.key === c.tag)?.label ?? c.tag}: {c.count.toLocaleString()}
              </span>
            ))}
          </div>
        </header>

        <StoresManager initial={withTags} countries={countries} />
      </div>
    </div>
  );
}
