import Link from "next/link";
import { redirect } from "next/navigation";
import { Wordmark } from "@/app/components/logo";
import { currentUser, isAdmin, adminEmails } from "@/lib/auth";
import { listSubscribers } from "@/lib/subscriptions";
import { counts } from "@/lib/imported";

export const metadata = { title: "Terrain — Admin" };
export const dynamic = "force-dynamic";

type Card = { href: string; title: string; blurb: string; accent?: boolean };
type Group = { key: string; label: string; hint: string; cards: Card[] };

export default async function Admin() {
  const email = await currentUser();
  if (!email) redirect("/login");
  if (!isAdmin(email)) redirect("/dashboard");

  // Sequential, not Promise.all — fanning out on the max:3 postgres.js pool deadlocks the page.
  const subs = await listSubscribers().catch(() => []);
  const c = await counts().catch(() => ({ pending: 0, published: 0 }));
  const withAccess = subs.filter((s) => s.status === "active" || s.status === "trialing").length;
  const trialing = subs.filter((s) => s.status === "trialing").length;
  const admins = adminEmails();

  const groups: Group[] = [
    {
      key: "access",
      label: "Access & billing",
      hint: "Who can get in, what they pay, and hand-picked trials.",
      cards: [
        {
          href: "/admin/subscribers",
          title: "Subscribers & trials",
          blurb: `${subs.length.toLocaleString()} total · ${withAccess.toLocaleString()} with access${trialing ? ` · ${trialing} on trial` : ""}. Grant a 7-day Pro trial to any email, comp access, switch plans, or cancel.`,
          accent: true,
        },
        {
          href: "/admin/integrations",
          title: "Billing & integrations",
          blurb: "Stripe, Beehiiv and the other connected services behind billing and capture.",
        },
      ],
    },
    {
      key: "ops",
      label: "Ops",
      hint: "The live pipeline — discovery, coverage, health.",
      cards: [
        { href: "/ops", title: "Ops overview", blurb: "Discovery throughput, imports in flight, and what the pipeline touched in the last 24h." },
        { href: "/ops/coverage", title: "Coverage by market", blurb: "Payment, shipping and enrichment completeness per country — where the gaps are." },
        { href: "/admin/churn", title: "Churn & liveness", blurb: "Stores going dark: frozen checkouts, dead domains, migrations." },
        { href: "/admin/providers", title: "Provider reports", blurb: "Shareable payment / shipping / subscription share dashboards." },
        { href: "/admin/radar", title: "Radar detections", blurb: "Clone-store and brand-abuse matches awaiting review.", accent: true },
      ],
    },
    {
      key: "data",
      label: "Data & imports",
      hint: "Bring stores in, review them, enrich and tag.",
      cards: [
        { href: "/admin/import", title: "Import store base", blurb: `Upload a CSV into the private pool${c.pending ? ` · ${c.pending.toLocaleString()} pending` : ""}. Enrich and publish from here.` },
        { href: "/admin/pending", title: "Review imports", blurb: "Confirm or reject imported stores before they hit the live feed." },
        { href: "/admin/explore", title: "Leads Explorer", blurb: "Slice the whole base by market, platform, provider and tag." },
        { href: "/admin/stores", title: "Leads & tags", blurb: "Search individual stores, edit tags and fix records." },
        { href: "/admin/leads", title: "Edit partner leads", blurb: "The curated partner / outreach list." },
      ],
    },
  ];

  return (
    <div className="min-h-screen px-4 py-6 md:px-8">
      <div className="mx-auto max-w-5xl">
        <nav className="flex items-center justify-between">
          <Link href="/"><Wordmark size="text-xl" /></Link>
          <span className="rounded-full border border-orange/30 bg-orange/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-orange">
            Admin
          </span>
        </nav>

        <header className="mt-10">
          <h1 className="font-display text-4xl md:text-5xl">Admin</h1>
          <p className="mt-2 max-w-2xl text-cream/60">
            Manage access and billing, keep an eye on ops, and run the data pipeline — all from here.
          </p>
        </header>

        {/* Permissions panel — who holds admin (set via ADMIN_EMAILS at deploy). */}
        <section className="mt-8 rounded-2xl border border-cream/12 bg-cream/[0.02] p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-cream/50">Permissions</h2>
            <span className="text-xs text-cream/40">Signed in as <span className="font-mono text-cream/70">{email}</span></span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {admins.map((a) => (
              <span key={a} className="rounded-full border border-cream/15 bg-cream/[0.03] px-3 py-1 font-mono text-xs text-cream/70">
                {a}
                {a === email.toLowerCase() && <span className="ml-1.5 text-cyan">you</span>}
              </span>
            ))}
          </div>
          <p className="mt-3 text-xs text-cream/40">
            Full admins have access to everything below. Set via the <span className="font-mono">ADMIN_EMAILS</span> allowlist (deploy config).
            Grant customers app access from <Link href="/admin/subscribers" className="text-cyan hover:underline">Subscribers &amp; trials</Link>.
          </p>
        </section>

        {groups.map((g) => (
          <section key={g.key} className="mt-10">
            <div className="flex items-baseline gap-3">
              <h2 className="font-display text-2xl">{g.label}</h2>
              <span className="text-sm text-cream/40">{g.hint}</span>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {g.cards.map((card) => (
                <Link
                  key={card.href}
                  href={card.href}
                  className={`group flex flex-col rounded-2xl border p-5 transition hover:bg-cream/[0.04] ${
                    card.accent ? "border-cyan/25 bg-cyan/[0.04]" : "border-cream/12 bg-cream/[0.02]"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-cream">{card.title}</h3>
                    <span className="text-cream/30 transition group-hover:translate-x-0.5 group-hover:text-cream/60">→</span>
                  </div>
                  <p className="mt-2 text-[13px] leading-relaxed text-cream/55">{card.blurb}</p>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
