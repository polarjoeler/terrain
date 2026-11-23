"use server";

/** Admin-only manual store editing. imported_stores is a SHARED table (every customer's dashboard
 *  reads the same rows), so this is gated hard to isAdmin — never a per-customer action. Each save
 *  stamps the matching *_source='manual' where one exists (so re-enrichment respects the override)
 *  and writes a store_edits audit row (who/when/field/old→new). See lead-drawer.tsx for the UI.
 *
 *  Every edited column is also LOCKED (imported_stores.locked_fields, lib/field-locks.ts): a database
 *  trigger keeps the hand-set value whichever crawler writes the row next, until it is unlocked here.
 *  Before `scripts/field-locks.ts --migrate` has run, edits still save, just without the lock. */
import { db } from "@/lib/db";
import { currentUser, isAdmin } from "@/lib/auth";
import { hasFieldLocks, lockSet } from "@/lib/field-locks";

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
  // Reach channels + descriptive fields. Lanes fill these only when empty (COALESCE-if-null), and the
  // contact lane leaves every channel alone once contact_source='manual', so a hand edit sticks.
  contact_phone?: string | null;
  whatsapp?: string | null;
  contact_form_url?: string | null;
  linkedin?: string | null;
  instagram?: string | null;
  facebook?: string | null;
  tiktok?: string | null;
  category?: string | null;
  city?: string | null;
  plus?: boolean;
  tags?: string[];
  // Crawler-owned fields. Without a lock the next probe would replace these, which is why #172 left
  // them out; with one they stay as typed until unlocked.
  payments?: string | null;
  shipping_providers?: string | null;
  technologies?: string | null;
  plugins?: string | null;
  apps?: string | null;
  theme?: string | null;
  currency?: string | null;
  product_count?: string | null;
  launched_at?: string | null;
};

const SCALARS = ["country", "platform", "published", "plus", "name", "category", "city", "estimated_monthly_sales",
  "contact_name", "contact_email", "contact_role", "contact_phone", "whatsapp", "contact_form_url",
  "linkedin", "instagram", "facebook", "tiktok",
  "payments", "shipping_providers", "technologies", "plugins", "apps", "theme", "currency", "product_count", "launched_at"] as const;
// Stored lists, written the way the lanes write them, so a typed "PayFast, Yoco" still feeds the
// payment facets and the payments taxonomy (scripts/payments-taxonomy.mjs).
const LISTS: Record<string, string> = { payments: "; ", shipping_providers: "; ", technologies: ";", plugins: ";" };
const BOOLEANS = new Set<string>(["published", "plus"]);
// Any of these edited → contact_source='manual', which scripts/contact-enrich.mjs treats as "a human
// owns this contact record" and stops overwriting.
const CONTACT_FIELDS = ["contact_name", "contact_email", "contact_role", "contact_phone", "whatsapp", "contact_form_url", "linkedin"] as const;

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
    SELECT ${sql(SCALARS as unknown as string[])}
    FROM imported_stores WHERE domain = ${d} LIMIT 1`;
  if (!cur) return { error: "not_found" };

  const norm = (v: unknown) => (v == null || v === "" ? null : String(v).trim() || null);
  // launched_at is a DATE column: postgres.js hands back a Date, the form sends YYYY-MM-DD.
  const asList = (v: string | null, f: string) => (v ? v.split(/[;,]/).map((t) => t.trim()).filter(Boolean).join(LISTS[f]) || null : null);
  const dateOnly = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : norm(v)?.slice(0, 10) ?? null);
  const set: Record<string, unknown> = {};
  const audits: { field: string; old: string | null; new: string | null }[] = [];

  for (const f of SCALARS) {
    if (!(f in patch)) continue;
    if (BOOLEANS.has(f)) {
      const nv = Boolean((patch as Record<string, unknown>)[f]);
      if (Boolean(cur[f]) === nv) continue;
      set[f] = nv;
      audits.push({ field: f, old: String(Boolean(cur[f])), new: String(nv) });
    } else {
      let nv = norm((patch as Record<string, unknown>)[f]);
      // Store numbers the way the lanes do (digits only, leading + kept) so wa.me links and the
      // WhatsApp/phone facets keep working on a hand-typed "+27 82 123 4567".
      if (nv && (f === "whatsapp" || f === "contact_phone")) nv = nv.replace(/(?!^\+)[^\d]/g, "") || null;
      if (nv && (f === "country" || f === "currency")) nv = nv.toUpperCase();
      if (nv && f === "currency" && !/^[A-Z]{3}$/.test(nv)) return { error: "currency must be a 3-letter code, e.g. ZAR" };
      if (nv && f in LISTS) nv = asList(nv, f);
      if (nv && f === "product_count") {
        if (!/^\d+$/.test(nv)) return { error: "product count must be a whole number" };
        nv = String(Number(nv));
      }
      if (nv && f === "launched_at" && !/^\d{4}-\d{2}-\d{2}$/.test(nv)) return { error: "launch date must be YYYY-MM-DD" };
      // Compare in the same shape: an untouched "PayFast;Yoco" must not read as an edit (and get locked)
      // just because the form would re-join it as "PayFast; Yoco".
      const ov = f === "launched_at" ? dateOnly(cur[f]) : f in LISTS ? asList(norm(cur[f]), f) : norm(cur[f]);
      if (ov === nv) continue;
      set[f] = nv;
      audits.push({ field: f, old: ov, new: nv });
    }
  }
  // A manual country fix must survive re-enrichment: country-enrich skips country_source='manual'.
  if ("country" in set) set.country_source = "manual";
  if ("launched_at" in set) set.launched_source = set.launched_at ? "manual" : null;
  if ("payments" in set) set.payments_source = set.payments ? "manual" : null;
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

  // Lock what was edited (plus its companion stamps), so no lane undoes it. Tags live in their own
  // table and no lane writes them, so they need no lock.
  const locking = await hasFieldLocks();
  const lock = lockSet(audits.map((a) => a.field).filter((f) => f !== "tags"));

  try {
    await sql.begin(async (q) => {
      // Marks this transaction as the admin edit, which the lock trigger lets through. SET LOCAL, not
      // SET: DATABASE_URL is the transaction pooler, where a session SET lasts one statement.
      await q`SELECT set_config('terrain.manual_edit', 'on', true)`;
      if (Object.keys(set).length) {
        await q`UPDATE imported_stores SET ${q(set, ...Object.keys(set))}
          ${locking && lock.length ? q`, locked_fields = ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(locked_fields, '{}'::text[]) || ${lock}::text[]) AS x ORDER BY 1)` : q``}
          WHERE domain = ${d}`;
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

/** Hand a field back to the crawlers: drop it (and its companion stamps) from the lock list. The
 *  value stays as it is until the next lane writes it. */
export async function unlockStoreField(domain: string, field: string): Promise<{ ok: true } | { error: string }> {
  const email = await currentUser();
  if (!isAdmin(email)) return { error: "unauthorized" };
  const d = (domain || "").trim().toLowerCase();
  if (!d || !field) return { error: "bad_request" };
  if (!(await hasFieldLocks())) return { error: "field locks not installed" };
  const sql = db();
  await ensureTables(sql);
  const drop = lockSet([field]);
  try {
    await sql.begin(async (q) => {
      await q`SELECT set_config('terrain.manual_edit', 'on', true)`;
      await q`UPDATE imported_stores SET locked_fields = NULLIF(ARRAY(
          SELECT x FROM unnest(locked_fields) AS x WHERE x <> ALL(${drop}::text[]) ORDER BY 1), '{}'::text[])
        WHERE domain = ${d}`;
      await q`INSERT INTO store_edits (domain, editor, field, old_value, new_value)
        VALUES (${d}, ${email}, ${"unlock:" + field}, 'locked', 'crawler-owned')`;
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "unlock_failed" };
  }
  return { ok: true };
}
