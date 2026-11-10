import { redirect } from "next/navigation";
import { currentUser, isAdmin } from "@/lib/auth";
import { getSubscriber, hasAccess } from "@/lib/subscriptions";
import { db } from "@/lib/db";
import { loadClusters, railsInPlay } from "@/lib/radar/clusters";
import { VISIBLE_MARKETS } from "@/lib/markets";
import { RadarView, type Lens } from "./radar-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Radar" };

/** Radar, inside Terrain.
 *
 *  It used to live at /radar on its own near-black canvas, deliberately styled to feel like a
 *  different product, and it read `radar_detections` — an engine whose last sweep was 3 October.
 *  Meanwhile the live signal (`catalog_matches`, re-swept weekly on Rex) was surfaced nowhere a
 *  customer could reach. So the Fraud Scanner showed stale data while the fresh data was invisible.
 *
 *  This is the same evidence inside Terrain's shell, pointed at the live table and passed through
 *  lib/radar/clusters, which is the part that makes it sellable: it says WHY two stores share a
 *  catalogue before it says anyone copied anyone.
 */
export default async function RadarPage({
  searchParams,
}: {
  searchParams: Promise<{ lens?: string; rail?: string; brand?: string; platform?: string }>;
}) {
  const email = await currentUser();
  if (!email) redirect("/login");
  if (!isAdmin(email)) {
    const sub = await getSubscriber(email).catch(() => null);
    if (!hasAccess(sub)) redirect("/billing");
  }

  const sp = await searchParams;
  const lens: Lens = (["rail", "brand", "platform", "market"] as const).includes(sp.lens as Lens)
    ? (sp.lens as Lens)
    : "market";

  // Sequential — the pool is small (see lib/db).
  const clusters = await loadClusters({ kinds: ["clone", "network", "unclear", "operator"] }).catch(() => []);
  const rails = await railsInPlay().catch(() => []);

  // Platform coverage, so an empty lens can say "not covered yet" rather than implying "clean".
  const platforms = await db()<{ platform: string; published: number; fingerprinted: number }[]>`
    SELECT s.platform,
           count(*)::int AS published,
           count(f.domain)::int AS fingerprinted
    FROM imported_stores s
    LEFT JOIN store_catalog_fp f ON f.domain = s.domain AND f.n_products > 0
    WHERE s.published AND s.country = ANY(${db().array([...VISIBLE_MARKETS])})
      AND (s.live_status IS NULL OR s.live_status NOT IN ('dead','migrated'))
    GROUP BY s.platform HAVING count(*) > 300
    ORDER BY count(*) DESC`.catch(() => []);

  const coverage = platforms.reduce(
    (a, p) => ({ published: a.published + p.published, fingerprinted: a.fingerprinted + p.fingerprinted }),
    { published: 0, fingerprinted: 0 },
  );

  return (
    <div className="mx-auto max-w-4xl">
      <header>
        <h1 className="font-display text-3xl text-cream md:text-4xl">Radar</h1>
        <p className="mt-2 text-cream/60">
          Stores selling a catalogue that isn&rsquo;t theirs — matched on real product images, SKUs,
          handles and prices, then sorted into what it actually is: a copy, a dropship network, or
          one business running several storefronts.
        </p>
      </header>

      <RadarView
        clusters={clusters}
        rails={rails}
        platforms={platforms}
        lens={lens}
        rail={sp.rail ?? ""}
        brand={sp.brand ?? ""}
        platform={sp.platform ?? ""}
        coverage={coverage}
      />
    </div>
  );
}
