/** The market fraud sweep itself — ONE implementation, shared by both callers:
 *    lib/radar/fraud-sweep.ts        (admin "Run sweep" button)
 *    scripts/radar-fraud-sweep.mjs   (4-hourly radar-pipeline.sh)
 *  They previously held separate copies of this algorithm and had already drifted.
 *
 *  Scoring lives in ./clone-score.mjs. This file is the data plumbing: cluster
 *  stores by shared product images, pick the most-established member as the
 *  victim, and judge every other member against it.
 *
 *  Pairs that look like ordinary commerce are NOT discarded — they're written to
 *  radar_relationships with the reason, so suppression is auditable and can be
 *  labelled later. They deliberately go in a separate table because the detection
 *  reads (listMonitorDetections, detectionsForBrands) do not filter on `source`,
 *  so anything in radar_detections reaches customer dashboards. */

import { TUNING, stemFanout, valueFanout, classify } from "./clone-score.mjs";

const MIN_SHARED_TO_CLUSTER = TUNING.MIN_SHARED;

/** "Established" score — the victim is the most legitimate store in a cluster. */
function establishment(s) {
  let n = s.n_products || 0;
  if (s.est_sales) n += Math.min(50, s.est_sales / 1000);
  if (s.payments) n += 20;
  if (s.plus) n += 40;
  if (s.discovered) n -= 5;
  return n;
}

async function ensureTables(sql) {
  await sql`CREATE TABLE IF NOT EXISTS radar_runs (
    id BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL,
    ran_at TIMESTAMPTZ NOT NULL DEFAULT now(), summary JSONB NOT NULL DEFAULT '{}')`;
  await sql`CREATE TABLE IF NOT EXISTS radar_relationships (
    brand_domain TEXT NOT NULL, suspect TEXT NOT NULL,
    reason TEXT NOT NULL, detail TEXT,
    overlap_score INT, impersonation_score INT,
    shared INT, exclusive INT,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    label TEXT,                                   -- set by a human: fraud | commerce | same-owner
    PRIMARY KEY (brand_domain, suspect))`;
  await sql`ALTER TABLE radar_detections ADD COLUMN IF NOT EXISTS overlap_score INT`;
  await sql`ALTER TABLE radar_detections ADD COLUMN IF NOT EXISTS impersonation_score INT`;
}

/**
 * @param sql        a postgres.js client
 * @param opts.write persist results (false = dry run / report only)
 * @returns summary object (also inserted into radar_runs when writing)
 */
export async function sweep(sql, { write = true } = {}) {
  await ensureTables(sql);

  const rows = await sql`
    SELECT f.domain, f.image_stems, f.n_products, f.price_by_handle,
           i.name, i.merchant_name, i.theme, i.apps,
           i.instagram, i.facebook, i.tiktok,
           i.product_count, i.first_product_at, i.launched_at, i.store_created,
           i.contact_email, i.email, i.contact_phone,
           i.estimated_monthly_sales AS est_sales, i.plus,
           (i.payments IS NOT NULL AND i.payments <> '') AS payments,
           (i.discovered_at IS NOT NULL) AS discovered
    FROM store_fingerprints f
    LEFT JOIN imported_stores i ON i.domain = f.domain
    WHERE f.status = 'ok' AND f.n_products > 0`;

  const store = new Map();
  for (const r of rows)
    store.set(r.domain, { ...r, stems: new Set(r.image_stems || []), priceByHandle: r.price_by_handle || {} });

  const members = [...store.values()];
  const fanout = stemFanout(members);
  const idFanout = valueFanout(members);

  // Pair stores by shared images, ignoring products carried so widely that they
  // identify a distributed brand rather than a copied catalogue.
  const byStem = new Map();
  for (const [domain, s] of store)
    for (const stem of s.stems) {
      if (!stem) continue;
      const arr = byStem.get(stem);
      if (arr) arr.push(domain); else byStem.set(stem, [domain]);
    }
  const pair = new Map();
  for (const [, domains] of byStem) {
    if (domains.length < 2 || domains.length > TUNING.MAX_STEM_STORES) continue;
    for (let i = 0; i < domains.length; i++)
      for (let j = i + 1; j < domains.length; j++) {
        const key = domains[i] < domains[j] ? `${domains[i]}|${domains[j]}` : `${domains[j]}|${domains[i]}`;
        pair.set(key, (pair.get(key) ?? 0) + 1);
      }
  }

  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { if (!parent.has(a)) parent.set(a, a); if (!parent.has(b)) parent.set(b, b); parent.set(find(a), find(b)); };
  for (const [key, shared] of pair) {
    if (shared < MIN_SHARED_TO_CLUSTER) continue;
    const [a, b] = key.split("|");
    union(a, b);
  }
  const clusters = new Map();
  for (const d of parent.keys()) {
    const root = find(d);
    const arr = clusters.get(root);
    if (arr) arr.push(d); else clusters.set(root, [d]);
  }
  const groups = [...clusters.values()].filter((c) => c.length >= 2);

  const detections = [], relationships = [];
  const suppressedBy = {};
  for (const domains of groups) {
    const ms = domains.map((d) => store.get(d)).sort((a, b) => establishment(b) - establishment(a));
    const victim = ms[0];
    for (const c of ms.slice(1)) {
      const r = classify(victim, c, fanout, idFanout);
      if (r.suppressed) {
        suppressedBy[r.suppressed] = (suppressedBy[r.suppressed] ?? 0) + 1;
        relationships.push({
          victim: victim.domain, suspect: c.domain, reason: r.suppressed, detail: r.detail ?? null,
          overlap: r.overlap?.score ?? null, imp: r.imp?.score ?? null,
          shared: r.overlap?.shared ?? null, exclusive: r.overlap?.exclusive ?? null,
        });
        continue;
      }
      detections.push({
        victim: victim.domain, victimName: victim.name, suspect: c.domain, suspectName: c.name,
        verdict: r.verdict, score: r.score, reasons: r.reasons,
        overlap: r.overlap.score, imp: r.imp.score,
      });
    }
  }

  const summary = {
    scanned: rows.length, clusters: groups.length,
    relationships: detections.length + relationships.length,
    written: 0, newDetections: 0, retired: 0,
    suppressed: relationships.length, ...Object.fromEntries(Object.entries(suppressedBy).map(([k, v]) => [`suppressed_${k}`, v])),
  };
  // NB: distinct keys — `relationships` in the summary is a COUNT, so the lists
  // must not shadow it.
  if (!write) return { ...summary, detectionList: detections, relationshipList: relationships, ranAt: new Date().toISOString() };

  const existing = new Set(
    (await sql`SELECT brand_domain, suspect FROM radar_detections WHERE source = 'fraud'`)
      .map((r) => `${r.brand_domain}|${r.suspect}`));

  // Batched writes. These sets run to thousands of rows, and row-at-a-time
  // INSERTs made the sweep take longer than its own 4-hourly schedule.
  const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

  for (const part of chunk(detections, 200)) {
    const rows = part.map((d) => ({
      brand_domain: d.victim, suspect: d.suspect,
      brand_name: d.victimName ?? d.victim, suspect_name: d.suspectName ?? d.suspect,
      verdict: d.verdict, score: d.score, reasons: sql.json(d.reasons),
      source: "fraud", overlap_score: d.overlap, impersonation_score: d.imp,
    }));
    await sql`
      INSERT INTO radar_detections ${sql(rows, "brand_domain", "suspect", "brand_name", "suspect_name", "verdict", "score", "reasons", "source", "overlap_score", "impersonation_score")}
      ON CONFLICT (brand_domain, suspect) DO UPDATE SET
        verdict = EXCLUDED.verdict, score = EXCLUDED.score, reasons = EXCLUDED.reasons,
        source = 'fraud', last_seen_at = now(),
        overlap_score = EXCLUDED.overlap_score, impersonation_score = EXCLUDED.impersonation_score`;
    summary.written += part.length;
  }
  for (const d of detections) if (!existing.has(`${d.victim}|${d.suspect}`)) summary.newDetections++;

  for (const part of chunk(relationships, 500)) {
    const rows = part.map((r) => ({
      brand_domain: r.victim, suspect: r.suspect, reason: r.reason, detail: r.detail,
      overlap_score: r.overlap, impersonation_score: r.imp, shared: r.shared, exclusive: r.exclusive,
    }));
    await sql`
      INSERT INTO radar_relationships ${sql(rows, "brand_domain", "suspect", "reason", "detail", "overlap_score", "impersonation_score", "shared", "exclusive")}
      ON CONFLICT (brand_domain, suspect) DO UPDATE SET
        reason = EXCLUDED.reason, detail = EXCLUDED.detail,
        overlap_score = EXCLUDED.overlap_score, impersonation_score = EXCLUDED.impersonation_score,
        shared = EXCLUDED.shared, exclusive = EXCLUDED.exclusive, last_seen_at = now()`;
  }

  // Retire fraud detections this sweep no longer stands behind, in one statement.
  const keep = detections.map((d) => `${d.victim}|${d.suspect}`);
  const retired = await sql`
    DELETE FROM radar_detections
    WHERE source = 'fraud' AND (brand_domain || '|' || suspect) <> ALL(${keep}::text[])
    RETURNING 1`;
  summary.retired = retired.length;

  await sql`INSERT INTO radar_runs (kind, summary) VALUES ('fraud', ${sql.json(summary)})`;
  return { ...summary, ranAt: new Date().toISOString() };
}
