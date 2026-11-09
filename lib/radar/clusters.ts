/** Radar's judgement layer: turn raw catalogue matches into things a buyer can act on.
 *
 *  `catalog_matches` (written weekly by scripts/clone-sweep.mjs on Rex) says "these two stores
 *  share a catalogue". That is a similarity statement, NOT an accusation, and shipping it raw is
 *  how you lose a payment processor's trust in one email. Measured on the live table: of 58 pairs
 *  the sweep calls "clone", six are the LEGO certified-store family, seven are one dropship
 *  network re-selling a shared supplier catalogue, and ten more share nothing but four stock theme
 *  images. Two legitimate storefronts of one owner (olivia-boutique / olivia-capetown) score 100.
 *
 *  So this module answers the question the matcher cannot: WHY do these two share a catalogue?
 *  Three shapes, read off the match graph itself with no extra crawling:
 *
 *    operator — a hard identity signal ties them (same Shopify shop_id, contact address, Instagram
 *               or phone). One business, several storefronts. Benign; suppressed by default.
 *    network  — a hub: some store shares its catalogue with three or more others. Dropshippers,
 *               distributors and franchise families look like this. Interesting to a processor as
 *               a RING, but nobody here is a victim, so it must not be reported as impersonation.
 *    clone    — a 1:1 pair with real catalogue overlap and no benign explanation. The actual
 *               product.
 *
 *  The evidence floor matters as much as the shapes. A match built only on images is worthless:
 *  stores on the same theme share its stock photography, which is what chains ten unrelated shops
 *  to theorezone.co.za at a median of four images and ZERO shared product handles. Requiring a
 *  shared handle or SKU — something that comes from a real catalogue, not a template — removes
 *  that entire class without a hand-maintained blocklist.
 *
 *  Deliberately platform-agnostic. It reads only `catalog_matches`, which carries no platform
 *  assumption, so the day the Woo lane lands (41,957 published Woo stores, 0 fingerprinted today
 *  against 59,169 Shopify at 5%) every lens below starts answering for Woo with no change here.
 *  A Woo clone of a Shopify brand is the likeliest real fraud and is exactly a cross-platform edge.
 *
 *  Pure apart from one read, and cheap at today's 85 edges — so the app calls it per request. If
 *  the Woo lane pushes edges into the thousands, the same function moves to a Rex job that writes
 *  a precomputed table; nothing here needs rewriting for that.
 */

import { db as sharedDb } from "../db";

function db() {
  return sharedDb();
}

export type ClusterKind = "clone" | "network" | "operator" | "unclear";

/** Why a pair might legitimately share a catalogue. Ordered strongest first. */
export type OwnershipSignal = "shop_id" | "email" | "instagram" | "phone";

const SIGNAL_LABEL: Record<OwnershipSignal, string> = {
  shop_id: "same Shopify store ID",
  email: "same contact address",
  instagram: "same Instagram account",
  phone: "same phone number",
};

export type ClusterMember = {
  domain: string;
  name: string | null;
  platform: string | null;
  country: string | null;
  rails: string[];
  estMonthlySales: number | null;
  /** How many other members this one shares a catalogue with. */
  degree: number;
};

export type ClusterEdge = {
  original: string;
  suspect: string;
  score: number;
  copiedShare: number | null;
  sharedImages: number;
  sharedSkus: number;
  sharedHandles: number;
  reasons: string[];
  ownership: OwnershipSignal[];
  firstSeen: string;
};

export type Cluster = {
  /** Stable across runs: the alphabetically first member. */
  id: string;
  kind: ClusterKind;
  /** One line a non-engineer can act on. */
  why: string;
  members: ClusterMember[];
  edges: ClusterEdge[];
  topScore: number;
  /** Strongest catalogue evidence anywhere in the cluster. */
  sharedHandles: number;
  rails: string[];
  platforms: string[];
  countries: string[];
  firstSeen: string;
  lastScanned: string;
};

/** Site identity — mirrors siteOf() in scripts/lib/catalog-fp.mjs, which the sweep uses. Inlined
 *  rather than imported because that module is plain .mjs loaded by raw Node on Rex; the lists must
 *  be kept in step. Applied again HERE rather than trusted: the live table still contains
 *  buildxonline.co.za ↔ www.buildxonline.co.za, one site reported as its own clone, and that pair
 *  surfaced under a payment processor's lens. Collapsing on read means a sweep that regresses can
 *  never put "this store copied itself" in front of a customer. */
const SLD = /^(?:co|com|org|net|ac|gov|edu|or|ne|web|ltd|plc|biz|info)\.[a-z]{2}$/;
const SHARED_HOSTS = new Set(["myshopify.com", "wixsite.com", "squarespace.com", "webflow.io",
  "business.site", "shop.app", "wordpress.com", "blogspot.com", "netlify.app", "vercel.app",
  "github.io", "square.site", "mystrikingly.com", "bigcartel.com", "myshopline.com", "ueniweb.com",
  "catlog.shop", "selar.co"]);

export function siteOf(domain: string): string {
  const host = domain.trim().toLowerCase().replace(/^www\./, "");
  const l = host.split(".");
  if (l.length <= 2) return host;
  const two = l.slice(-2).join(".");
  if (SHARED_HOSTS.has(two)) return host;
  return l.slice(SLD.test(two) ? -3 : -2).join(".");
}

/** Words that say nothing about who owns a domain. */
const GENERIC = new Set(["store", "shop", "shopping", "online", "africa", "sa", "za", "the", "my",
  "buy", "best", "deals", "group", "trading", "supplies", "direct", "co", "ltd", "official", "www"]);

/** Do two sites share a distinctive word? "olivia-boutique" and "olivia-capetown" do.
 *  This is NOT evidence of ownership — see the note by ownershipSignals. */
function relatedNames(a: string, b: string): string | null {
  const core = (d: string) => siteOf(d).split(".")[0];
  const toks = (d: string) =>
    new Set(core(d).split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !GENERIC.has(t)));
  const ta = toks(a), tb = toks(b);
  for (const t of ta) if (tb.has(t)) return t;
  const ca = core(a), cb = core(b);
  if (ca.length >= 5 && cb.includes(ca)) return ca;
  if (cb.length >= 5 && ca.includes(cb)) return cb;
  return null;
}

/** A match built only on images is a shared THEME, not a shared catalogue. */
const hasRealEvidence = (e: { sku_n: number; handle_n: number }) => e.handle_n > 0 || e.sku_n > 0;

/** A store sharing its catalogue with this many others is a hub, not a victim. */
const HUB_DEGREE = 3;

const splitRails = (p: string | null): string[] =>
  (p ?? "").split(";").map((s) => s.trim()).filter(Boolean);

type EdgeRow = {
  original: string; suspect: string; score: number; verdict: string; kind: string;
  copied_share: number | null; img_n: number; sku_n: number; handle_n: number;
  reasons: string[] | null; first_seen_at: Date; scanned_at: Date;
};
type StoreRow = {
  domain: string; name: string | null; platform: string | null; country: string | null;
  payments: string | null; estimated_monthly_sales: number | null;
  shop_id: string | null; mail: string | null; instagram: string | null; phone: string | null;
};

export type LensOpts = {
  /** "On my rail": match a payment provider on either side of the pair. */
  rail?: string;
  /** "My brand / my client": only clusters containing this domain. */
  domain?: string;
  /** "On my platform". */
  platform?: string;
  /** Which shapes to return. Defaults to the actionable two. */
  kinds?: ClusterKind[];
  /** Include matches with no shared handle or SKU. Off by default — see the header. */
  includeWeak?: boolean;
  limit?: number;
};

/** Build the classified clusters, optionally through one buyer's lens. */
export async function loadClusters(opts: LensOpts = {}): Promise<Cluster[]> {
  const { rail, domain, platform, kinds, includeWeak = false, limit } = opts;

  const rows = await db()<EdgeRow[]>`
    SELECT original, suspect, score, verdict, kind, copied_share,
           img_n, sku_n, handle_n, reasons, first_seen_at, scanned_at
    FROM catalog_matches`;
  const edgeRows = rows.filter((r) => includeWeak || hasRealEvidence(r));
  if (!edgeRows.length) return [];

  const domains = [...new Set(edgeRows.flatMap((r) => [r.original, r.suspect]))];
  const stores = await db()<StoreRow[]>`
    SELECT domain, name, platform, country, payments, estimated_monthly_sales,
           shop_id, lower(COALESCE(contact_email, email, '')) AS mail,
           lower(COALESCE(instagram, '')) AS instagram, COALESCE(phone, '') AS phone
    FROM imported_stores WHERE domain = ANY(${db().array(domains)})`;
  // Keyed BOTH ways: edges are canonicalised to the site, but imported_stores rows carry the
  // host as crawled (often www.), so a site-keyed lookup must still find them.
  const byDomain = new Map<string, StoreRow>();
  for (const s of stores) {
    byDomain.set(s.domain, s);
    const site = siteOf(s.domain);
    if (!byDomain.has(site)) byDomain.set(site, s);
  }

  return assemble(edgeRows, byDomain, { rail, domain, platform, kinds, limit });
}

/** The pure half — exported so a Rex job can precompute without re-querying. */
export function assemble(
  edgeRowsIn: EdgeRow[],
  byDomain: Map<string, StoreRow>,
  opts: Pick<LensOpts, "rail" | "domain" | "platform" | "kinds" | "limit"> = {},
): Cluster[] {
  let edgeRows = edgeRowsIn;

  // --- connected components (union-find) ---
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    parent.set(x, parent.get(x) ?? x);
    const p = parent.get(x)!;
    if (p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  // Canonicalise to the SITE first, then drop what that reveals as self-matches and duplicates.
  const canon: EdgeRow[] = [];
  const seenPair = new Map<string, EdgeRow>();
  for (const raw of edgeRows) {
    const a = siteOf(raw.original), b = siteOf(raw.suspect);
    if (a === b) continue;                       // one site, two spellings — not a clone
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    const e = { ...raw, original: a, suspect: b };
    const prev = seenPair.get(key);
    if (!prev || e.score > prev.score) seenPair.set(key, e);  // keep the strongest evidence
  }
  canon.push(...seenPair.values());
  edgeRows = canon;

  for (const e of edgeRows) union(e.original, e.suspect);

  const groups = new Map<string, EdgeRow[]>();
  for (const e of edgeRows) {
    const root = find(e.original);
    const list = groups.get(root) ?? [];
    list.push(e);
    groups.set(root, list);
  }

  const clusters: Cluster[] = [];
  for (const edges of groups.values()) {
    const names = [...new Set(edges.flatMap((e) => [e.original, e.suspect]))].sort();
    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.original, (degree.get(e.original) ?? 0) + 1);
      degree.set(e.suspect, (degree.get(e.suspect) ?? 0) + 1);
    }

    const built: ClusterEdge[] = edges.map((e) => ({
      original: e.original,
      suspect: e.suspect,
      score: e.score,
      copiedShare: e.copied_share,
      sharedImages: e.img_n,
      sharedSkus: e.sku_n,
      sharedHandles: e.handle_n,
      reasons: e.reasons ?? [],
      ownership: ownershipSignals(byDomain.get(e.original), byDomain.get(e.suspect)),
      firstSeen: new Date(e.first_seen_at).toISOString(),
    }));

    const members: ClusterMember[] = names.map((d) => {
      const s = byDomain.get(d);
      return {
        domain: d,
        name: s?.name ?? null,
        platform: s?.platform ?? null,
        country: s?.country ?? null,
        rails: splitRails(s?.payments ?? null),
        estMonthlySales: s?.estimated_monthly_sales ?? null,
        degree: degree.get(d) ?? 0,
      };
    });

    const tied = built.filter((e) => e.ownership.length).length;
    const maxDegree = Math.max(...members.map((m) => m.degree));
    // Identity beats shape: a family that also looks like a hub (the LEGO stores do) is still one
    // business. Half the edges is the bar, because a 6-store family rarely links every pair.
    const related = built.some((e) => relatedNames(e.original, e.suspect));
    const kind: ClusterKind =
      tied * 2 >= built.length && tied > 0
        ? "operator"
        : maxDegree >= HUB_DEGREE
          ? "network"
          // Related names with no identity proof are the one case we must NOT call: it reads
          // equally as a second storefront or a deliberate look-alike, and guessing either way
          // is a wrong answer to a processor. It goes to a human instead.
          : related
            ? "unclear"
            : "clone";

    clusters.push({
      id: names[0],
      kind,
      why: explain(kind, built, members, tied),
      members,
      edges: built.sort((a, b) => b.score - a.score),
      topScore: Math.max(...built.map((e) => e.score)),
      sharedHandles: Math.max(...built.map((e) => e.sharedHandles)),
      rails: [...new Set(members.flatMap((m) => m.rails))].sort(),
      platforms: [...new Set(members.map((m) => m.platform).filter((p): p is string => !!p))].sort(),
      countries: [...new Set(members.map((m) => m.country).filter((c): c is string => !!c))].sort(),
      firstSeen: built.map((e) => e.firstSeen).sort()[0],
      lastScanned: new Date(Math.max(...edges.map((e) => new Date(e.scanned_at).getTime()))).toISOString(),
    });
  }

  return applyLens(clusters, opts);
}

function ownershipSignals(a: StoreRow | undefined, b: StoreRow | undefined): OwnershipSignal[] {
  if (!a || !b) return [];
  const out: OwnershipSignal[] = [];
  if (a.shop_id && a.shop_id === b.shop_id) out.push("shop_id");
  if (a.mail && a.mail === b.mail) out.push("email");
  if (a.instagram && a.instagram === b.instagram) out.push("instagram");
  if (a.phone && a.phone === b.phone) out.push("phone");
  return out;
}

/** Deliberately NOT a signal: a shared domain word. "olivia-boutique" and "olivia-capetown" are
 *  probably one owner, but "nikeshoes-sa" and "nike-outlet-sa" are probably two impersonators —
 *  the test cannot tell those apart, and guessing wrong HIDES fraud. Left to the human. */

function explain(kind: ClusterKind, edges: ClusterEdge[], members: ClusterMember[], tied: number): string {
  const n = members.length;
  if (kind === "operator") {
    const sigs = [...new Set(edges.flatMap((e) => e.ownership))].map((s) => SIGNAL_LABEL[s]);
    return `${n} storefronts that appear to be one business — ${sigs.join(", ")} on ${tied} of ${edges.length} pairs.`;
  }
  if (kind === "unclear") {
    const word = edges.map((e) => relatedNames(e.original, e.suspect)).find(Boolean);
    return `Both domains contain "${word}" and they share ${Math.max(...edges.map((e) => e.sharedHandles)).toLocaleString()} products, but nothing proves common ownership. Either one business with two storefronts, or a deliberate look-alike — worth asking the merchant.`;
  }
  if (kind === "network") {
    const hub = [...members].sort((a, b) => b.degree - a.degree)[0];
    return `${n} stores selling the same catalogue, centred on ${hub.domain}. Typical of a dropship or distributor network rather than one store copying another.`;
  }
  const top = edges[0] ?? null;
  const shared = top ? Math.max(top.sharedHandles, top.sharedSkus) : 0;
  return `${shared.toLocaleString()} identical products with no sign of shared ownership — the pattern of one store copying another.`;
}

function applyLens(
  clusters: Cluster[],
  { rail, domain, platform, kinds, limit }: Pick<LensOpts, "rail" | "domain" | "platform" | "kinds" | "limit">,
): Cluster[] {
  const want = new Set<ClusterKind>(kinds ?? ["clone", "network"]);
  const railLc = rail?.trim().toLowerCase();
  const domainLc = domain?.trim().toLowerCase().replace(/^www\./, "");

  let out = clusters.filter((c) => want.has(c.kind));
  if (railLc) out = out.filter((c) => c.rails.some((r) => r.toLowerCase().includes(railLc)));
  if (platform) out = out.filter((c) => c.platforms.includes(platform));
  if (domainLc) {
    out = out.filter((c) => c.members.some((m) => m.domain.toLowerCase().replace(/^www\./, "") === domainLc));
  }

  // Severity = how many products were taken, discounted by how sure we are. Volume alone put a
  // 237-product match we score 25 above a 118-product match we score 82, which reads as confidence
  // we don't have; score alone would rank a 4-product certainty above a 900-product theft.
  const severity = (c: Cluster) => c.sharedHandles * (c.topScore / 100);
  out.sort((a, b) => severity(b) - severity(a) || b.topScore - a.topScore || b.members.length - a.members.length);
  return typeof limit === "number" ? out.slice(0, limit) : out;
}

/** Rails present across the live match set — for the processor lens's picker. */
export async function railsInPlay(): Promise<{ rail: string; clusters: number }[]> {
  const clusters = await loadClusters({ kinds: ["clone", "network"] });
  const counts = new Map<string, number>();
  for (const c of clusters) for (const r of c.rails) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts.entries()]
    .map(([rail, n]) => ({ rail, clusters: n }))
    .sort((a, b) => b.clusters - a.clusters || a.rail.localeCompare(b.rail));
}
