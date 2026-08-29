/** Land CT-tailer discoveries into imported_stores.
 *
 *  ~/shopify-radar/ct_tail.py tails the CT logs directly (no crt.sh) and appends
 *  every .za domain it confirms resolves to Shopify to feed/ct-discoveries.jsonl.
 *  This lands them: brand-new domains are inserted (source=ct_tail, published), and
 *  domains we already track just get discovered_at backfilled — never overwritten.
 *
 *  The overlap it prints IS the recall signal: of the stores the CT tail found, how
 *  many did our (crt.sh-based) pipeline already have vs. how many are genuinely new?
 *  Lots of "new" = crt.sh was missing them = our recall was lower than we thought.
 *
 *    node --env-file=.env.local scripts/land-ct-discoveries.mjs
 */
import postgres from "postgres";
import { readFileSync } from "fs";

const FINDS = process.env.CT_FINDS || "/Users/joel/shopify-radar/feed/ct-discoveries.jsonl";

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  let text = "";
  try {
    text = readFileSync(FINDS, "utf8");
  } catch {
    console.log(`No CT discoveries file at ${FINDS} yet — nothing to land.`);
    return;
  }

  // domain -> { at: earliest seen date, country }
  const seen = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      const d = String(r.domain || "").trim().toLowerCase();
      if (!d) continue;
      const at = (r.seen_at || "").slice(0, 10) || today();
      const country = (r.country || "ZA").toUpperCase();  // older records had no country → ZA
      const prev = seen.get(d);
      if (!prev || at < prev.at) seen.set(d, { at, country });
    } catch {
      /* skip malformed line */
    }
  }
  if (!seen.size) {
    console.log("CT discoveries file is empty — nothing to land.");
    return;
  }

  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3, idle_timeout: 20 });
  try {
    const existing = new Set(
      (await sql`SELECT domain FROM imported_stores WHERE domain = ANY(${[...seen.keys()]})`).map((r) => r.domain),
    );
    const fresh = [...seen.keys()].filter((d) => !existing.has(d));

    const records = [...seen.entries()].map(([domain, { at, country }]) => ({
      domain,
      name: domain,
      country,
      discovered_at: at,
      published: true,
      source: "ct_tail",
    }));
    const cols = ["domain", "name", "country", "discovered_at", "published", "source"];
    for (let i = 0; i < records.length; i += 400) {
      const batch = records.slice(i, i + 400);
      // Insert new; for existing, only backfill discovered_at (never touch source /
      // published / any enriched field — those belong to the record we already have).
      await sql`
        INSERT INTO imported_stores ${sql(batch, ...cols)}
        ON CONFLICT (domain) DO UPDATE SET
          discovered_at = COALESCE(imported_stores.discovered_at, EXCLUDED.discovered_at)`;
    }

    const overlap = seen.size - fresh.length;
    const recallPct = seen.size ? ((overlap / seen.size) * 100).toFixed(0) : "—";
    console.log(`CT-tail discoveries: ${seen.size} total`);
    console.log(`  already tracked (overlap): ${overlap} (${recallPct}%)`);
    console.log(`  NEW (crt.sh had missed):   ${fresh.length}`);
    if (fresh.length) console.log("  sample new:", fresh.slice(0, 12).join(", "));
    console.log(`\n→ recall read: of stores the independent CT tail saw, we already had ${recallPct}%.`);
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
