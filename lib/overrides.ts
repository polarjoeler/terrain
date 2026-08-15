/** Manual lead corrections — a durable overrides layer.
 *
 *  fetchLeads applies these LAST, so a fix always wins over the Sheet or the
 *  imported base and survives the pipeline re-enriching its source. Editing the
 *  Google Sheet directly doesn't survive; an override does.
 */

import { db, ensureSchema } from "./radar/db";
import type { Lead } from "./leads";

export type Override = {
  domain: string;
  name: string | null;
  email: string | null;
  country: string | null;
  currency: string | null;
  plus: boolean | null;
  theme: string | null;
  product_count: number | null;
  price_min: number | null;
  price_max: number | null;
  payments: string | null;
  hidden: boolean;
  note: string | null;
};

const FIELDS = [
  "name", "email", "country", "currency", "plus", "theme",
  "product_count", "price_min", "price_max", "payments", "hidden", "note",
] as const;

export async function getOverride(domain: string): Promise<Override | null> {
  await ensureSchema();
  const rows = await db()`SELECT * FROM lead_overrides WHERE domain = ${domain} LIMIT 1`;
  return (rows[0] as Override) ?? null;
}

export async function saveOverride(
  domain: string,
  fields: Partial<Override>,
  updatedBy: string,
): Promise<void> {
  await ensureSchema();
  const row: Record<string, unknown> = { domain, updated_by: updatedBy };
  for (const f of FIELDS) if (f in fields) row[f] = (fields as Record<string, unknown>)[f];
  const cols = Object.keys(row);
  await db()`
    INSERT INTO lead_overrides ${db()(row, ...cols)}
    ON CONFLICT (domain) DO UPDATE SET
      ${db()(row, ...cols.filter((c) => c !== "domain"))},
      updated_at = now()
  `;
}

export async function clearOverride(domain: string): Promise<void> {
  await ensureSchema();
  await db()`DELETE FROM lead_overrides WHERE domain = ${domain}`;
}

/** Apply overrides to a lead list: patch non-null fields, drop hidden leads. */
export async function applyOverrides(leads: Lead[]): Promise<Lead[]> {
  await ensureSchema();
  const rows = (await db()`SELECT * FROM lead_overrides`) as unknown as Override[];
  if (!rows.length) return leads;
  const byDomain = new Map(rows.map((r) => [r.domain, r]));

  const out: Lead[] = [];
  for (const l of leads) {
    const o = byDomain.get(l.domain);
    if (!o) { out.push(l); continue; }
    if (o.hidden) continue; // removed correction
    out.push({
      ...l,
      name: o.name ?? l.name,
      email: o.email ?? l.email,
      country: o.country ?? l.country,
      currency: o.currency ?? l.currency,
      plus: o.plus ?? l.plus,
      theme: o.theme ?? l.theme,
      productCount: o.product_count ?? l.productCount,
      priceMin: o.price_min != null ? Number(o.price_min) : l.priceMin,
      priceMax: o.price_max != null ? Number(o.price_max) : l.priceMax,
      payments: o.payments ? o.payments.split(";").filter(Boolean) : l.payments,
    });
  }
  return out;
}
