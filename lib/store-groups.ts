/** Store groups — the other stores run by the same operator as this one, with the evidence that
 *  links them. Built by scripts/build-store-groups.mjs (store_groups + store_group_members). */

import { db } from "./db";

export type StoreGroupMember = {
  domain: string; name: string | null; platform: string | null; country: string | null;
  /** Why this store is in the group: "Same contact email", "Email at tregerbrands.co.za", … */
  reasons: string[];
};

export type StoreGroup = {
  groupId: string;
  label: string | null;
  operatorDomain: string | null;
  sites: number;
  /** Why THIS store is in the group. */
  reasons: string[];
  /** The other stores, one per site (www/apex twins collapsed), biggest first. */
  others: StoreGroupMember[];
};

const MAX_OTHERS = 12;

export async function getStoreGroup(domain: string): Promise<StoreGroup | null> {
  const d = domain.trim().toLowerCase();
  const [g] = await db()<{ group_id: string; site: string; reasons: string[]; label: string | null; operator_domain: string | null; n_sites: number }[]>`
    SELECT m.group_id, m.site, m.reasons, g.label, g.operator_domain, g.n_sites
    FROM store_group_members m JOIN store_groups g USING (group_id)
    WHERE m.domain = ${d} AND NOT g.review LIMIT 1`;
  if (!g) return null;
  const others = await db()<StoreGroupMember[]>`
    SELECT m.site AS domain, s.name, s.platform, s.country, m.reasons
    FROM store_group_members m LEFT JOIN imported_stores s ON s.domain = m.site
    WHERE m.group_id = ${g.group_id} AND m.domain = m.site AND m.site <> ${g.site}
      AND m.site !~ '\\.myshopify\\.com$'
    ORDER BY s.estimated_monthly_sales DESC NULLS LAST, m.site
    LIMIT ${MAX_OTHERS}`;
  return { groupId: g.group_id, label: g.label, operatorDomain: g.operator_domain, sites: g.n_sites, reasons: g.reasons, others };
}
