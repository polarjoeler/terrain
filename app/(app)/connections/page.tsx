import { redirect } from "next/navigation";
import { currentUser, isAdmin } from "@/lib/auth";
import { getSubscriber, hasAccess, usageFor } from "@/lib/subscriptions";
import { platformsFor, PLANS } from "@/lib/plans";
import { PROVIDERS, listConnections } from "@/lib/integrations";
import { availableCountries } from "@/lib/insights";
import { outreachCounts, OUTREACH_MARKETS } from "@/lib/imported";
import { ConnectionsPanel } from "@/app/components/connections-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Connections" };

/** Push leads into the tool the customer already works in. The (app) layout has already done auth
 *  and the paywall; the guard below is the defence-in-depth that layout asks pages to keep.
 *
 *  Reads are SEQUENTIAL, not Promise.all: the pool is small and fanning out on it is what hung the
 *  Overview page once (see lib/db). Three cheap reads in series cost less than that risk. */
export default async function ConnectionsPage() {
  const email = await currentUser();
  if (!email) redirect("/login");

  const admin = isAdmin(email);
  const sub = admin ? null : await getSubscriber(email).catch(() => null);
  if (!admin && !hasAccess(sub)) redirect("/billing");

  const scope = admin ? null : platformsFor(sub?.plan);
  const usage = admin ? null : usageFor(sub);

  const connections = await listConnections(email).catch(() => []);
  // availableCountries() is the insights picker (FOCUS_MARKETS — Africa plus Japan). The push is
  // gated to OUTREACH_MARKETS, so offering Japan here would be an option that always returns zero.
  const countries = (await availableCountries().catch(() => []))
    .filter((c) => OUTREACH_MARKETS.includes(c.country));
  // Default cohort = all markets, at the plan's platform ceiling. The panel re-sizes on change.
  const counts = await outreachCounts({ platforms: scope }).catch(() => ({ reachable: 0, all: 0 }));

  // Export is the gate a push goes through, so the two states that block it are named up front
  // rather than discovered by clicking: a trial hasn't unlocked export, and a spent allowance
  // can't fund one. Connecting stays available in both — the key can be in place for later.
  const pushBlocked = !admin && sub?.status === "trialing"
    ? "Pushing unlocks when you upgrade from the trial to a paid plan. You can connect your tools now — they'll be ready."
    : null;

  // Woo is the richer half of the base and is deliberately withheld until Partner (lib/plans), so
  // say so where the number is visibly narrowed rather than letting the cohort look thin.
  const scopeNote = scope?.length
    ? `Counts cover ${scope.join(" and ")} stores on your plan. ${PLANS.partner.label} adds WooCommerce and every other platform we track.`
    : null;

  return (
    <div className="mx-auto max-w-3xl">
      <header>
        <h1 className="font-display text-3xl text-cream md:text-4xl">Connections</h1>
        <p className="mt-2 text-cream/60">
          Send leads straight into the tool you already work in — a cold-email sequence, your CRM,
          an enrichment table, or a Slack channel. Keys are stored encrypted and only stores with a
          contact email are ever pushed.
        </p>
      </header>

      <ConnectionsPanel
        providers={PROVIDERS}
        connected={connections.map((c) => ({ provider: c.provider, config: c.config }))}
        countries={countries}
        allowance={usage ? { used: usage.used, limit: usage.limit, remaining: usage.remaining } : null}
        initialCounts={counts}
        pushBlocked={pushBlocked}
        scopeNote={scopeNote}
      />
    </div>
  );
}
