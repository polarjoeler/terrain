#!/usr/bin/env node
/**
 * Market-wide fraud sweep — proactive, no enrolled brand needed.
 *
 * Every store is fingerprinted, so stores that SHARE a catalogue (same product
 * images) are surfaced by the collision itself: clone farms, counterfeit rings,
 * dropship networks. We build an inverted index over image stems, link stores
 * that share enough of them, cluster the links, then in each cluster pick the
 * likely VICTIM (most established) vs the CLONES (fresh / thin / no real
 * payment) and record victim→clone into radar_detections (source='fraud').
 *
 *   node --env-file=.env.local scripts/radar-fraud-sweep.mjs          # report
 *   node --env-file=.env.local scripts/radar-fraud-sweep.mjs --write  # persist
 */

import postgres from "postgres";

const WRITE = process.argv.includes("--write");
const MIN_SHARED = 4;        // stores must share ≥N image stems to be linked
const MAX_STEM_STORES = 15;  // a stem on >N stores is a generic/placeholder — ignore
const MIN_CLUSTER = 2;

// Same-owner detection — a merchant's own myshopify default domain, or the same
// brand on two TLDs (brand.com ↔ brand.co.za), is NOT a clone. Skip those.
const SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "ac", "edu", "or", "ne"]);
function label(domain) {
  const d = (domain || "").toLowerCase();
  if (d.endsWith(".myshopify.com")) return d.slice(0, -".myshopify.com".length);
  const parts = d.split(".");
  if (parts.length > 1) parts.pop();
  if (parts.length > 1 && SECOND_LEVEL.has(parts[parts.length - 1])) parts.pop();
  return parts.join(".");
}
const HOMO = [[/rn/g, "m"], [/vv/g, "w"], [/0/g, "o"], [/1/g, "l"], [/5/g, "s"], [/3/g, "e"]];
function canon(s) { let o = (s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); for (const [re, to] of HOMO) o = o.replace(re, to); return o; }
function sameOwner(a, b) {
  const ca = canon(label(a)), cb = canon(label(b));
  if (!ca || !cb) return false;
  if (ca === cb) return true;
  const [s, l] = ca.length < cb.length ? [ca, cb] : [cb, ca];
  return s.length >= 5 && l.includes(s); // e.g. kikakids ⊂ kikakidsboutique
}

function scoreStore(s) {
  // "Established" score — the victim is the most legitimate store in a cluster.
  let n = (s.n_products || 0);
  if (s.est_sales) n += Math.min(50, s.est_sales / 1000); // sales weight, capped
  if (s.payments) n += 20;   // has a verified/known payment stack
  if (s.plus) n += 40;       // Shopify Plus = real merchant
  if (s.discovered) n -= 5;  // freshly discovered = more likely the clone
  return n;
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3, onnotice: () => {} });
  try {
    await sql`SELECT 1`;
    // Fingerprints + the legitimacy signals used to pick victim vs clone.
    const rows = await sql`
      SELECT f.domain, f.image_stems, f.n_products,
             i.name, i.country, i.estimated_monthly_sales AS est_sales,
             i.plus, (i.payments IS NOT NULL AND i.payments <> '') AS payments,
             (i.discovered_at IS NOT NULL) AS discovered
      FROM store_fingerprints f
      LEFT JOIN imported_stores i ON i.domain = f.domain
      WHERE f.status = 'ok' AND f.n_products > 0`;
    console.log(`Scanning ${rows.length.toLocaleString()} fingerprinted stores…`);

    const store = new Map();
    for (const r of rows) store.set(r.domain, { ...r, stems: new Set(r.image_stems || []) });

    // Inverted index: image stem -> [domains]. Skip generic (ubiquitous) stems.
    const byStem = new Map();
    for (const [domain, s] of store)
      for (const stem of s.stems) {
        if (!stem) continue;
        (byStem.get(stem) ?? byStem.set(stem, []).get(stem)).push(domain);
      }

    // Count shared stems per store-pair (only via non-generic stems).
    const pair = new Map();
    for (const [, domains] of byStem) {
      if (domains.length < 2 || domains.length > MAX_STEM_STORES) continue;
      for (let i = 0; i < domains.length; i++)
        for (let j = i + 1; j < domains.length; j++) {
          const key = domains[i] < domains[j] ? `${domains[i]}|${domains[j]}` : `${domains[j]}|${domains[i]}`;
          pair.set(key, (pair.get(key) ?? 0) + 1);
        }
    }

    // Union-find over pairs that share ≥ MIN_SHARED stems.
    const parent = new Map();
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const union = (a, b) => { if (!parent.has(a)) parent.set(a, a); if (!parent.has(b)) parent.set(b, b); parent.set(find(a), find(b)); };
    let edges = 0;
    for (const [key, shared] of pair) {
      if (shared < MIN_SHARED) continue;
      const [a, b] = key.split("|");
      union(a, b); edges++;
    }

    // Assemble clusters.
    const clusters = new Map();
    for (const d of parent.keys()) {
      const root = find(d);
      (clusters.get(root) ?? clusters.set(root, []).get(root)).push(d);
    }
    const groups = [...clusters.values()].filter((c) => c.length >= MIN_CLUSTER)
      .sort((a, b) => b.length - a.length);

    console.log(`Found ${edges.toLocaleString()} strong links → ${groups.length.toLocaleString()} catalogue-collision clusters (${MIN_SHARED}+ shared images).\n`);

    const detections = [];
    for (const domains of groups) {
      const members = domains.map((d) => store.get(d)).sort((a, b) => scoreStore(b) - scoreStore(a));
      const victim = members[0];
      const clones = members.slice(1);
      // Shared-image count between victim and each clone (evidence).
      for (const c of clones) {
        if (sameOwner(victim.domain, c.domain)) continue; // same merchant, not a clone
        let shared = 0;
        for (const stem of c.stems) if (victim.stems.has(stem)) shared++;
        const ratio = shared / Math.max(1, Math.min(victim.stems.size, c.stems.size));
        detections.push({
          victim: victim.domain, victimName: victim.name, clone: c.domain, cloneName: c.name,
          country: c.country, shared, ratio, clusterSize: domains.length,
          score: Math.min(100, Math.round(ratio * 100)),
        });
      }
    }

    detections.sort((a, b) => b.score - a.score || b.shared - a.shared);
    console.log(`Top suspected clones (victim ← clone · shared images):`);
    for (const d of detections.slice(0, 20))
      console.log(`  ${String(d.score).padStart(3)}  ${d.victim}  ←  ${d.clone}   (${d.shared} shared, cluster of ${d.clusterSize})`);
    console.log(`\nTotal: ${detections.length.toLocaleString()} suspected clone relationships across ${groups.length} clusters.`);

    const MIN_PERSIST_SHARED = 10; // real overlap, not coincidence
    const strong = detections.filter((d) => d.shared >= MIN_PERSIST_SHARED);
    console.log(`\n${strong.length.toLocaleString()} high-confidence (${MIN_PERSIST_SHARED}+ shared images).`);

    if (WRITE) {
      await sql`ALTER TABLE radar_detections ADD COLUMN IF NOT EXISTS source TEXT`;
      await sql`ALTER TABLE radar_detections ADD COLUMN IF NOT EXISTS dismissed BOOLEAN NOT NULL DEFAULT false`;
      await sql`CREATE TABLE IF NOT EXISTS radar_runs (id BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL, ran_at TIMESTAMPTZ NOT NULL DEFAULT now(), summary JSONB NOT NULL DEFAULT '{}')`;
      const existing = new Set(
        (await sql`SELECT brand_domain, suspect FROM radar_detections WHERE source = 'fraud'`)
          .map((r) => `${r.brand_domain}|${r.suspect}`),
      );
      let n = 0, fresh = 0;
      for (const d of strong) {
        const verdict = d.score >= 75 ? "COPY" : d.score >= 50 ? "LIKELY" : "PARTIAL";
        const reasons = [`${d.shared} identical product images shared with ${d.victim}`,
          `part of a ${d.clusterSize}-store catalogue-collision cluster`];
        if (!existing.has(`${d.victim}|${d.clone}`)) fresh++;
        await sql`
          INSERT INTO radar_detections (brand_domain, suspect, brand_name, suspect_name, verdict, score, reasons, source, last_seen_at)
          VALUES (${d.victim}, ${d.clone}, ${d.victimName ?? d.victim}, ${d.cloneName ?? d.clone}, ${verdict}, ${d.score}, ${sql.json(reasons)}, 'fraud', now())
          ON CONFLICT (brand_domain, suspect) DO UPDATE SET
            verdict = EXCLUDED.verdict, score = EXCLUDED.score, reasons = EXCLUDED.reasons,
            source = 'fraud', last_seen_at = now()`;
        n++;
      }
      await sql`INSERT INTO radar_runs (kind, summary) VALUES ('fraud', ${sql.json({ scanned: rows.length, clusters: groups.length, relationships: detections.length, written: n, newDetections: fresh })})`;
      console.log(`\n✓ Wrote ${n.toLocaleString()} fraud detections (${fresh} new) → radar_detections. Run recorded.`);
    } else {
      console.log(`\n(report only — re-run with --write to persist into radar_detections)`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((e) => { console.error("failed:", e.message); process.exit(1); });
