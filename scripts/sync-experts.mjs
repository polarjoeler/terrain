/** Sync the Africa Shop Experts (Fundi) directory into Terrain's Postgres.
 *
 * Source: the africa-shopify-connect Lovable app's Supabase `experts` table (139 published
 * agencies/pros). We COPY them into our own `service_partners` table so the Service Partners
 * directory reads our DB — self-contained, no runtime coupling to that app being up.
 *
 * Credentials: EXPERTS_SUPABASE_URL / EXPERTS_SUPABASE_KEY if set, else read from the repo's
 * .env (the publishable/anon key is a client-side key — safe to read locally).
 *
 *   node --env-file=.env.local scripts/sync-experts.mjs [--dry-run]
 */
import postgres from "postgres";
import { readFileSync } from "node:fs";

const DRY = process.argv.includes("--dry-run");

function supabaseCreds() {
  let url = process.env.EXPERTS_SUPABASE_URL, key = process.env.EXPERTS_SUPABASE_KEY;
  if (!url || !key) {
    try {
      const env = readFileSync("/Users/joel/africa-shopify-connect/.env", "utf8");
      const get = (k) => (env.match(new RegExp(`${k}=(.*)`)) || [])[1]?.trim().replace(/^["']|["']$/g, "");
      url = url || get("VITE_SUPABASE_URL");
      key = key || get("VITE_SUPABASE_PUBLISHABLE_KEY");
    } catch { /* fall through */ }
  }
  return { url, key };
}

async function fetchExperts(url, key) {
  const cols = ["id", "name", "type", "role", "country", "location", "bio", "services", "skills",
    "certifications", "partner_programs", "languages", "rating", "starting_price", "currency_code",
    "completed_projects", "years_experience", "response_time", "availability", "is_pro",
    "website_url", "logo_url", "avatar", "updated_at"].join(",");
  const out = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${url}/rest/v1/experts?select=${cols}&is_published=eq.true&limit=1000&offset=${from}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`supabase ${res.status}: ${await res.text()}`);
    const batch = await res.json();
    out.push(...batch);
    if (batch.length < 1000) break;
  }
  return out;
}

async function main() {
  const { url, key } = supabaseCreds();
  if (!url || !key) { console.error("No Supabase creds (EXPERTS_SUPABASE_URL/KEY or africa-shopify-connect/.env)"); process.exit(2); }

  const experts = await fetchExperts(url, key);
  console.log(`fetched ${experts.length} published experts from Supabase${DRY ? " [DRY]" : ""}`);
  if (DRY) { console.log("sample:", JSON.stringify(experts.slice(0, 2), null, 1).slice(0, 500)); return; }

  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3, idle_timeout: 20 });
  try {
    await sql`CREATE TABLE IF NOT EXISTS service_partners (
      id text PRIMARY KEY, name text, type text, role text, country text, location text, bio text,
      services text[] DEFAULT '{}', skills text[] DEFAULT '{}', certifications text[] DEFAULT '{}',
      partner_programs text[] DEFAULT '{}', languages text[] DEFAULT '{}',
      rating numeric, starting_price numeric, currency_code text,
      completed_projects int, years_experience int, response_time text, availability text,
      is_pro boolean, website_url text, logo_url text, avatar text,
      stores_linked int, source_updated_at timestamptz, synced_at timestamptz NOT NULL DEFAULT now())`;
    await sql`ALTER TABLE service_partners ADD COLUMN IF NOT EXISTS source text DEFAULT 'fundi'`;

    const arr = (v) => (Array.isArray(v) ? v : []);
    const rows = experts.map((e) => ({
      id: e.id, name: e.name, type: e.type, role: e.role, country: e.country, location: e.location, bio: e.bio,
      services: arr(e.services), skills: arr(e.skills), certifications: arr(e.certifications),
      partner_programs: arr(e.partner_programs), languages: arr(e.languages),
      rating: e.rating ?? null, starting_price: e.starting_price ?? null, currency_code: e.currency_code ?? null,
      completed_projects: e.completed_projects ?? null, years_experience: e.years_experience ?? null,
      response_time: e.response_time ?? null, availability: e.availability ?? null, is_pro: e.is_pro ?? null,
      website_url: e.website_url ?? null, logo_url: e.logo_url ?? null, avatar: e.avatar ?? null,
      source_updated_at: e.updated_at ?? null,
    }));
    // Small table (~139 rows) — full replace in a transaction, preserving any stores_linked
    // we've computed on our side (re-applied after the reload).
    const cols = Object.keys(rows[0]);
    const linked = new Map((await sql`SELECT id, stores_linked FROM service_partners WHERE stores_linked IS NOT NULL`)
      .map((r) => [r.id, r.stores_linked]));
    await sql.begin(async (tx) => {
      // Replace only the Fundi-sourced rows — never touch agencies we DISCOVERED ourselves.
      await tx`DELETE FROM service_partners WHERE source IS NULL OR source = 'fundi'`;
      for (let i = 0; i < rows.length; i += 200) {
        await tx`INSERT INTO service_partners ${tx(rows.slice(i, i + 200).map((r) => ({ ...r, source: "fundi" })), ...cols, "source")}`;
      }
      for (const [id, n] of linked) await tx`UPDATE service_partners SET stores_linked = ${n} WHERE id = ${id}`;
    });
    console.log(`synced ${rows.length} Fundi experts → service_partners (discovered rows preserved; ${linked.size} stores_linked preserved).`);
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
