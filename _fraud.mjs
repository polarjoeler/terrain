import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { prepare:false, max:2, onnotice:()=>{} });
const [c] = await sql`SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE status='ok' AND n_products>0)::int with_catalog FROM store_fingerprints`;
console.log("fingerprints:", JSON.stringify(c));
// image stems shared across MULTIPLE distinct stores = evidence of copied catalogs
const shared = await sql`
  WITH stems AS (
    SELECT domain, jsonb_array_elements_text(image_stems) AS stem
    FROM store_fingerprints WHERE status='ok' AND n_products>0
  )
  SELECT stem, COUNT(DISTINCT domain)::int stores
  FROM stems GROUP BY stem HAVING COUNT(DISTINCT domain) BETWEEN 2 AND 60
  ORDER BY stores DESC LIMIT 8`;
console.log("top shared image stems (same image on N stores):");
for (const r of shared) console.log(`  ${r.stores} stores share image: ${r.stem.slice(0,50)}`);
const [agg] = await sql`
  WITH stems AS (
    SELECT domain, jsonb_array_elements_text(image_stems) AS stem
    FROM store_fingerprints WHERE status='ok' AND n_products>0
  ), shared AS (
    SELECT stem FROM stems GROUP BY stem HAVING COUNT(DISTINCT domain) BETWEEN 2 AND 60
  )
  SELECT COUNT(*)::int shared_images, COUNT(DISTINCT s.domain)::int stores_involved
  FROM stems s JOIN shared sh ON s.stem = sh.stem`;
console.log("collision totals:", JSON.stringify(agg));
await sql.end();
