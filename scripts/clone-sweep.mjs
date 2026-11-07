/** Clone sweep — which ZA/KE/NG stores host another store's catalogue.
 *
 *  Reads every store_catalog_fp row once (DB-light: one cursor scan), builds an in-memory inverted
 *  index of image and SKU hashes, and scores each pair that shares enough of them with the Brand
 *  Audit weights (lib/radar/catalog.ts: image 34 / sku 26 / handle 22 / title 18, ×(1+0.15·price
 *  mirror), containment vs the smaller catalogue). Results upsert into catalog_matches, keeping
 *  first_seen_at — how long a clone has been up is takedown evidence.
 *
 *  Two things a raw overlap score gets wrong, handled here:
 *   - Same operator: sister stores share a catalogue legitimately. Pairs in one store group
 *     (store_group_members) or on the same site are skipped.
 *   - Stockists: a reseller carrying 40 of a brand's 50 products scores high against the smaller
 *     catalogue. `kind` separates them: 'clone' when most of the YOUNGER store's own catalogue came
 *     from the other one, 'stockist' when it's a sliver of a bigger, multi-source catalogue.
 *  Images/SKUs present in more than HUB stores (theme demo photos, supplier stock shots) never
 *  generate candidates.
 *
 *   node --env-file=.env.local scripts/clone-sweep.mjs [--dry-run]
 */
import postgres from "postgres";

const DRY = process.argv.includes("--dry-run");
const HUB = 25;          // a hash in more stores than this is boilerplate, not evidence
const MIN_SHARED = 3;    // shared images + SKUs before a pair is scored at all
const MIN_SCORE = 25;    // PARTIAL and up are kept
const W = { img: 34, sku: 26, handle: 22, title: 18 };

const verdictFor = (s) => (s >= 75 ? "COPY" : s >= 50 ? "LIKELY" : s >= 25 ? "PARTIAL" : "clean");
const site = (d) => d.replace(/^www\./, "");

// Sorted Int32Array intersection count.
function inter(a, b) {
  let i = 0, j = 0, n = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { n++; i++; j++; } else if (a[i] < b[j]) i++; else j++;
  }
  return n;
}
// Share of handles present in both whose min price matches to the cent.
function priceMirror(a, b) {
  let i = 0, j = 0, both = 0, same = 0;
  while (i < a.handle.length && j < b.handle.length) {
    if (a.handle[i] === b.handle[j]) {
      if (a.price[i] > 0 && b.price[j] > 0) { both++; if (a.price[i] === b.price[j]) same++; }
      i++; j++;
    } else if (a.handle[i] < b.handle[j]) i++; else j++;
  }
  return both ? same / both : 0;
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 2, idle_timeout: 20 });
  try {
    await sql`SET statement_timeout = '120s'`;
    const t0 = Date.now();
    const S = [];
    const toI32 = (a) => Int32Array.from(a ?? []);
    for await (const batch of sql`
        SELECT f.domain, f.n_products, f.img, f.sku, f.handle, f.title, f.price,
               coalesce(f.earliest_product, s.first_product_at::date, s.launched_at::date) AS born,
               s.name, m.group_id
        FROM store_catalog_fp f
        LEFT JOIN imported_stores s ON s.domain = f.domain
        LEFT JOIN store_group_members m ON m.domain = f.domain
        WHERE f.n_products > 0`.cursor(500)) {
      for (const r of batch) S.push({
        domain: r.domain, name: r.name, n: r.n_products, born: r.born, group: r.group_id,
        img: toI32(r.img), sku: toI32(r.sku), handle: toI32(r.handle), title: toI32(r.title), price: toI32(r.price),
      });
    }
    console.log(`Loaded ${S.length.toLocaleString()} fingerprints in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // Inverted index over image + SKU hashes (kept apart: an image hash equal to a SKU hash is chance).
    const index = (kind) => {
      const m = new Map();
      S.forEach((s, i) => { for (const h of s[kind]) { const l = m.get(h); if (l) l.push(i); else m.set(h, [i]); } });
      let hubs = 0;
      for (const [h, l] of m) if (l.length > HUB) { m.delete(h); hubs++; }
      return { m, hubs };
    };
    const IMG = index("img"), SKU = index("sku");
    console.log(`Index: ${IMG.m.size.toLocaleString()} images (${IMG.hubs} boilerplate dropped), ${SKU.m.size.toLocaleString()} SKUs (${SKU.hubs} dropped)`);

    const matches = [];
    let scored = 0, sameOp = 0;
    for (let i = 0; i < S.length; i++) {
      const a = S[i];
      const counts = new Map();
      for (const idx of [IMG.m, SKU.m]) for (const h of (idx === IMG.m ? a.img : a.sku)) {
        const l = idx.get(h);
        if (l) for (const j of l) if (j > i) counts.set(j, (counts.get(j) ?? 0) + 1);
      }
      for (const [j, c] of counts) {
        if (c < MIN_SHARED) continue;
        const b = S[j];
        if (site(a.domain) === site(b.domain) || (a.group && a.group === b.group)) { sameOp++; continue; }
        scored++;
        const k = { img: inter(a.img, b.img), sku: inter(a.sku, b.sku), handle: inter(a.handle, b.handle), title: inter(a.title, b.title) };
        const ratio = (kind) => { const m = Math.min(a[kind].length, b[kind].length); return m ? k[kind] / m : 0; };
        const pm = priceMirror(a, b);
        const score = Math.min(100, Math.round((W.img * ratio("img") + W.sku * ratio("sku") + W.handle * ratio("handle") + W.title * ratio("title")) * (1 + 0.15 * pm)));
        if (score < MIN_SCORE) continue;
        // Original = the older catalogue (earliest product), else the bigger one.
        const aFirst = a.born && b.born ? a.born <= b.born : a.n >= b.n;
        const [orig, sus] = aFirst ? [a, b] : [b, a];
        // How much of the SUSPECT's own catalogue is the original's: high = clone, low = stockist.
        const copied = Math.max(
          sus.img.length ? k.img / sus.img.length : 0,
          sus.handle.length ? k.handle / sus.handle.length : 0,
          sus.title.length ? k.title / sus.title.length : 0);
        const reasons = [];
        if (k.img) reasons.push(`${k.img} identical product images`);
        if (k.sku) reasons.push(`${k.sku} identical SKUs`);
        if (k.handle) reasons.push(`${k.handle} identical product handles`);
        if (k.title) reasons.push(`${k.title} identical product titles`);
        if (pm) reasons.push(`prices mirrored on ${Math.round(pm * 100)}% of shared products`);
        matches.push({
          original: orig.domain, suspect: sus.domain, score, verdict: verdictFor(score),
          kind: copied >= 0.5 ? "clone" : "stockist", copied_share: Math.round(copied * 1000) / 1000,
          img_n: k.img, sku_n: k.sku, handle_n: k.handle, title_n: k.title, price_mirror: Math.round(pm * 1000) / 1000, reasons,
        });
      }
    }
    matches.sort((x, y) => y.score - x.score);
    const by = (f) => matches.reduce((o, m) => ((o[f(m)] = (o[f(m)] ?? 0) + 1), o), {});
    console.log(`Scored ${scored.toLocaleString()} pairs (${sameOp.toLocaleString()} same-operator skipped) → ${matches.length} matches`, by((m) => `${m.kind}/${m.verdict}`));
    for (const m of matches.filter((m) => m.kind === "clone").slice(0, 15))
      console.log(`  ${String(m.score).padStart(3)} ${m.verdict.padEnd(7)} ${m.suspect} ← ${m.original} · ${Math.round(m.copied_share * 100)}% of its catalogue · ${m.reasons.slice(0, 2).join(", ")}`);
    if (DRY) return;

    const [{ t }] = await sql`SELECT to_regclass('public.catalog_matches') AS t`;
    if (!t) {
      await sql`CREATE TABLE catalog_matches (
        original text NOT NULL, suspect text NOT NULL,
        score int NOT NULL, verdict text NOT NULL, kind text NOT NULL, copied_share real NOT NULL,
        img_n int NOT NULL, sku_n int NOT NULL, handle_n int NOT NULL, title_n int NOT NULL, price_mirror real NOT NULL,
        reasons text[] NOT NULL,
        first_seen_at timestamptz NOT NULL DEFAULT now(), scanned_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (original, suspect))`;
      await sql`CREATE INDEX catalog_matches_suspect ON catalog_matches (suspect)`;
    }
    // Batched upsert; rows not re-found keep their old scanned_at (a gutted clone stays on record).
    for (let i = 0; i < matches.length; i += 500) {
      const chunk = matches.slice(i, i + 500);
      await sql`INSERT INTO catalog_matches ${sql(chunk, "original", "suspect", "score", "verdict", "kind", "copied_share", "img_n", "sku_n", "handle_n", "title_n", "price_mirror", "reasons")}
        ON CONFLICT (original, suspect) DO UPDATE SET score = EXCLUDED.score, verdict = EXCLUDED.verdict, kind = EXCLUDED.kind,
          copied_share = EXCLUDED.copied_share, img_n = EXCLUDED.img_n, sku_n = EXCLUDED.sku_n, handle_n = EXCLUDED.handle_n,
          title_n = EXCLUDED.title_n, price_mirror = EXCLUDED.price_mirror, reasons = EXCLUDED.reasons, scanned_at = now()`;
    }
    console.log(`✓ Upserted ${matches.length} matches in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } finally {
    await sql.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
