/** Service Partners — the agencies & pros directory, synced from Africa Shop Experts (Fundi)
 *  into our own service_partners table by scripts/sync-experts.mjs. A payments co / emerging
 *  app uses it to see who's who among the builders to approach for GTM via this channel. */
import postgres from "postgres";

let _sql: ReturnType<typeof postgres> | null = null;
function db() {
  if (!_sql) _sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 3, idle_timeout: 20 });
  return _sql;
}

export type ServicePartner = {
  id: string; name: string; type: string | null; country: string | null; location: string | null;
  bio: string | null; services: string[]; skills: string[]; partnerPrograms: string[];
  rating: number | null; startingPrice: number | null; currency: string | null;
  completedProjects: number | null; yearsExperience: number | null; isPro: boolean;
  websiteUrl: string | null; storesLinked: number | null; source: string; verified: boolean;
};

export async function servicePartners(): Promise<ServicePartner[]> {
  const sql = db();
  try {
    const rows = await sql`
      SELECT id, name, type, country, location, bio, services, skills, partner_programs,
             rating, starting_price, currency_code, completed_projects, years_experience,
             is_pro, website_url, stores_linked, COALESCE(source, 'fundi') AS source
      FROM service_partners
      ORDER BY (COALESCE(source,'fundi') = 'fundi') DESC, is_pro DESC NULLS LAST,
               stores_linked DESC NULLS LAST, rating DESC NULLS LAST, completed_projects DESC NULLS LAST, name`;
    return rows.map((r) => ({
      id: r.id, name: r.name, type: r.type, country: r.country, location: r.location, bio: r.bio,
      services: r.services ?? [], skills: r.skills ?? [], partnerPrograms: r.partner_programs ?? [],
      rating: r.rating != null ? Number(r.rating) : null,
      startingPrice: r.starting_price != null ? Number(r.starting_price) : null, currency: r.currency_code,
      completedProjects: r.completed_projects, yearsExperience: r.years_experience, isPro: !!r.is_pro,
      websiteUrl: r.website_url, storesLinked: r.stores_linked,
      source: r.source, verified: r.source === "fundi",
    }));
  } catch { return []; }   // table not synced yet
}
