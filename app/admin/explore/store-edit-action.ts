"use server";

/** Admin-only manual store editing. imported_stores is a SHARED table (every customer's dashboard
 *  reads the same rows), so this is gated hard to isAdmin — never a per-customer action. Each save
 *  stamps the matching *_source='manual' where one exists (so re-enrichment respects the override)
 *  and writes a store_edits audit row (who/when/field/old→new). See lead-drawer.tsx for the UI. */
import { db } from "@/lib/db";
import { currentUser, isAdmin } from "@/lib/auth";

export type StorePatch = {
  country?: string | null;
  platform?: string | null;
  published?: boolean;
  name?: string | null;
  estimated_monthly_sales?: string | null;
  // Contact — admin-entered, authoritative. The email a person at the store, e.g. luca@tekkietown.co.za,
  // goes in contact_email (the VERIFIED field), never the guess column.
  contact_name?: string | null;
  contact_email?: string | null;
  contact_role?: string | null;
  tags?: string[];
};

const SCALARS = ["country", "platform", "published", "name", "estimated_monthly_sales", "contact_name", "contact_email", "contact_role"] as const;
const CONTACT_FIELDS = ["contact_name", "contact_email", "contact_role"] as const;

let tablesReady = false;
async function ensureTables(sql: ReturnType<typeof db>) {
  if (tablesReady) return;
  await sql`CREATE TABLE IF NOT EXISTS store_edits (
    id bigserial PRIMARY KEY, domain text NOT NULL, editor text, field text,
    old_value text, new_value text, edited_at timestamptz DEFAULT now())`;
  await sql`CREATE TABLE IF NOT EXISTS store_tags (domain text, tag text, PRIMARY KEY (domain, tag))`;
  tablesReady = true;
}

export async function updateStore(domain: string, patch: StorePatch): Promise<{ ok: true } | { error: string }> {
  const email = await currentUser();
  if (!isAdmin(email)) return { error: "unauthorized" };
  const d = (domain || "").trim().toLowerCase();
  if (!d) return { error: "bad_domain" };
  const sql = db();
  await ensureTables(sql);

  const [cur] = await sql<Record<string, unknown>[]>`
    SELECT country, platform, published, name, estimated_monthly_sales, contact_name, contact_email, contact_role
    FROM imported_stores WHERE domain = ${d} LIMIT 1`;
  if (!cur) return { error: "not_found" };

  const norm = (v: unknown) => (v == null || v === "" ? null : String(v).trim() || null);
  const set: Record<string, unknown> = {};
  const audits: { field: string; old: string | null; new: string | null }[] = [];

  for (const f of SCALARS) {
    if (!(f in patch)) continue;
    if (f === "published") {
      const nv = Boolean(patch.published);
      if (Boolean(cur.published) === nv) continue;
      set[f] = nv;
      audits.push({ field: f, old: String(Boolean(cur.published)), new: String(nv) });
    } else {
      const nv = norm((patch as Record<string, unknown>)[f]);
      const ov = norm(cur[f]);
      if (ov === nv) continue;
      set[f] = nv;
      audits.push({ field: f, old: ov, new: nv });
    }
  }
  // A manual country fix must survive re-enrichment: country-enrich skips country_source='manual'.
  if ("country" in set) set.country_source = "manual";
  // A hand-set revenue (a typed figure or a band picked in the drawer) must win over the MODELED
  // price immediately: revExpr() reads COALESCE(revenue_ballpark_usd, usd(estimated_monthly_sales)),
  // so leaving the ballpark columns in place would keep showing the model's band until the next
  // revenue-ballpark run. Do here exactly what that script's manual branch does (it keys off these
  // store_edits rows to leave the store alone from now on).
  if ("estimated_monthly_sales" in set) {
    set.revenue_ballpark_usd = null;
    set.revenue_ballpark_zar = null;
    set.revenue_low_usd = null;
    set.revenue_high_usd = null;
    set.revenue_low_zar = null;
    set.revenue_high_zar = null;
    set.revenue_band = null;
    set.revenue_model = "manual";
    set.revenue_confidence = "good";
  }
  // A manual contact edit is authoritative — stamp it so the contact lane treats it as done (and
  // should skip contact_source='manual'), and mark it "named" so it counts toward "reaches a person".
  if (CONTACT_FIELDS.some((f) => f in set)) {
    set.contact_source = "manual";
    set.contact_checked_at = new Date();
    if ("contact_name" in set) set.contact_type = set.contact_name ? "named" : null;
  }

  try {
    await sql.begin(async (q) => {
      if (Object.keys(set).length) {
        await q`UPDATE imported_stores SET ${q(set, ...Object.keys(set))} WHERE domain = ${d}`;
      }
      if (patch.tags) {
        const want = new Set(patch.tags.map((t) => t.trim()).filter(Boolean));
        const have = new Set((await q<{ tag: string }[]>`SELECT tag FROM store_tags WHERE domain = ${d}`).map((r) => r.tag));
        const add = [...want].filter((t) => !have.has(t));
        const del = [...have].filter((t) => !want.has(t));
        for (const t of add) await q`INSERT INTO store_tags (domain, tag) VALUES (${d}, ${t}) ON CONFLICT DO NOTHING`;
        if (del.length) await q`DELETE FROM store_tags WHERE domain = ${d} AND tag = ANY(${del})`;
        if (add.length || del.length) audits.push({ field: "tags", old: [...have].sort().join(", "), new: [...want].sort().join(", ") });
      }
      for (const a of audits) {
        await q`INSERT INTO store_edits (domain, editor, field, old_value, new_value)
          VALUES (${d}, ${email}, ${a.field}, ${a.old}, ${a.new})`;
      }
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "save_failed" };
  }
  return { ok: true };
}
