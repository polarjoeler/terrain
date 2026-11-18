"use server";

/** Admin-only manual store editing. imported_stores is a SHARED table (every customer's dashboard
 *  reads the same rows), so this is gated hard to isAdmin — never a per-customer action. Each save
 *  stamps the matching *_source='manual' where one exists (so re-enrichment respects the override)
 *  and writes a store_edits audit row (who/when/field/old→new). See lead-drawer.tsx for the UI. */
import { db } from "@/lib/db";
import { currentUser, isAdmin } from "@/lib/auth";
import { normalizeCcy } from "@/lib/fx";
import { existingStoreColumns } from "@/lib/columns";

export type StorePatch = {
  // --- identity / geography
  name?: string | null;
  country?: string | null;
  city?: string | null;
  category?: string | null;
  description?: string | null;
  // --- commercial
  platform?: string | null;
  plus?: boolean;
  currency?: string | null;
  estimated_monthly_sales?: string | null;
  // --- lifecycle. These two decide whether the row is a lead at all, so they are the edits with
  // the widest effect and the ones the lanes have to be taught to respect — see LIFECYCLE below.
  published?: boolean;
  live_status?: string | null;
  activity_tier?: string | null;
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
  // --- retail presence. physical_store is THREE-valued on purpose: true / false / null is
  // "has a shop" / "we looked and it has none" / "nobody has looked", and a card-present segment
  // needs the last two kept apart — so this is a tri-state picker, never a checkbox.
  physical_store?: boolean | null;
  store_address?: string | null;
  /** The shop's own phone. The EXISTING vendor/import column, not a new one — contact_phone is
   *  the contact's line and the two are routinely different for a retailer. */
  phone?: string | null;
  linkedin?: string | null;
  instagram?: string | null;
  facebook?: string | null;
  tiktok?: string | null;
  tags?: string[];
};

/** Every hand-editable column. DELIBERATELY NOT HERE: the measured ones — payments, apps,
 *  plugins, technologies, shipping_providers, theme, product_count, crux_rank, hosting_*,
 *  platform_version. Each is written by a probe on its own schedule and several carry a parsing
 *  taxonomy (scripts/payments-taxonomy.mjs), so a typed value would be both unverifiable and
 *  overwritten by the next run — an edit box there would promise something it cannot keep. Fix
 *  those at the probe. Everything a human can genuinely know better than a crawler is here. */
const SCALARS = [
  "name", "country", "city", "category", "description",
  "platform", "plus", "currency", "estimated_monthly_sales",
  "published", "live_status", "activity_tier",
  "contact_name", "contact_email", "contact_role", "contact_phone", "contact_form_url",
  "physical_store", "store_address", "phone",
  "whatsapp", "linkedin", "instagram", "facebook", "tiktok",
] as const;
const BOOLS = new Set(["published", "plus"]);
/** Booleans that must keep a third state. Boolean() would fold null into false and lose the
 *  difference between "no shop" and "not assessed". */
const TRISTATE = new Set(["physical_store"]);
// Any of these edited -> contact_source='manual', which scripts/contact-enrich.mjs treats as "a human
// owns this contact record" and stops overwriting. Widened to every channel by #172 — this branch
// predated that and listed only the three name/email/role fields.
const CONTACT_FIELDS = ["contact_name", "contact_email", "contact_role", "contact_phone", "whatsapp", "contact_form_url", "linkedin"] as const;

/** What an admin may set live_status to. off_24 and inactive are lane-internal bookkeeping
 *  (focus-liveness' "resolving off Shopify's /24", and a legacy value), not verdicts a human
 *  should hand-pick, so they are not offered — and an attempt to set one is refused rather than
 *  quietly dropped. "" clears the field back to NULL = never checked. */
const LIVE_STATUS = ["active", "dead", "migrated"] as const;
const ACTIVITY_TIER = ["selling", "active", "dormant", "not_a_store"] as const;
/** Terminal states: every customer query excludes them (lib/browse.ts), which is what makes
 *  "mark it dead" the single most powerful edit in this drawer. */
const TERMINAL = new Set<string>(["dead", "migrated"]);

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

  // Narrowed to the columns the database actually has: a field declared in lib/schema.sql can be
  // a script-run behind this code (lib/columns.ts explains why), and an unknown column fails the
  // whole statement — which would make EVERY save fail, not just the new field's.
  const cols = await existingStoreColumns(SCALARS);
  const editable = new Set(cols);
  // Must cover every editable SCALAR: the old value is what the audit row records and what the
  // no-op check compares against, so a column missing here would log "null → x" unchanged.
  const [cur] = await sql<Record<string, unknown>[]>`
    SELECT ${sql.unsafe(cols.join(", "))}, live_miss, last_alive_at
    FROM imported_stores WHERE domain = ${d} LIMIT 1`;
  if (!cur) return { error: "not_found" };

  const norm = (v: unknown) => (v == null || v === "" ? null : String(v).trim() || null);
  const set: Record<string, unknown> = {};
  const audits: { field: string; old: string | null; new: string | null }[] = [];

  // Normalise where the column has a canonical form, and REFUSE where it has a constraint — a
  // write that violates one throws inside the transaction and loses the whole save, so the
  // cheaper failure is to say which field is wrong before touching the row.
  if ("country" in patch) {
    const c = norm(patch.country);
    if (c && !/^[A-Za-z]{2}$/.test(c)) return { error: "country must be a 2-letter ISO code (ZA, KE, NG…)" };
    patch.country = c ? c.toUpperCase() : null;
  }
  if ("currency" in patch) {
    // imported_stores_currency_iso CHECKs ^[A-Z]{3}$ or NULL (see memory: currency-case-canonical).
    const raw = norm(patch.currency);
    const c = normalizeCcy(raw);
    if (raw && !c) return { error: "currency must be a 3-letter ISO 4217 code (ZAR, USD…)" };
    patch.currency = c;
  }
  if ("live_status" in patch) {
    const v = norm(patch.live_status);
    if (v && !(LIVE_STATUS as readonly string[]).includes(v)) return { error: `live_status must be one of ${LIVE_STATUS.join(", ")} (or blank)` };
    patch.live_status = v;
  }
  if ("activity_tier" in patch) {
    const v = norm(patch.activity_tier);
    if (v && !(ACTIVITY_TIER as readonly string[]).includes(v)) return { error: `activity_tier must be one of ${ACTIVITY_TIER.join(", ")} (or blank)` };
    patch.activity_tier = v;
  }

  for (const f of SCALARS) {
    if (!(f in patch)) continue;
    if (!editable.has(f)) continue;   // column not in the database yet — silently not editable
    if (TRISTATE.has(f)) {
      const raw = (patch as Record<string, unknown>)[f];
      const nv = raw == null || raw === "" ? null : Boolean(raw);
      const ov = cur[f] == null ? null : Boolean(cur[f]);
      if (ov === nv) continue;
      set[f] = nv;
      audits.push({ field: f, old: ov == null ? null : String(ov), new: nv == null ? null : String(nv) });
    } else if (BOOLS.has(f)) {
      const nv = Boolean((patch as Record<string, unknown>)[f]);
      if (Boolean(cur[f]) === nv) continue;
      set[f] = nv;
      audits.push({ field: f, old: String(Boolean(cur[f])), new: String(nv) });
    } else {
      let nv = norm((patch as Record<string, unknown>)[f]);
      // Store numbers the way the lanes do (digits only, leading + kept) so wa.me links and the
      // WhatsApp/phone facets keep working on a hand-typed "+27 82 123 4567".
      if (nv && (f === "whatsapp" || f === "contact_phone")) nv = nv.replace(/(?!^\+)[^\d]/g, "") || null;
      if (nv && f === "country") nv = nv.toUpperCase();
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
  // LIFECYCLE ------------------------------------------------------------------------------
  // Marking a store dead is the edit with the longest reach: every customer query excludes
  // dead/migrated (lib/browse.ts), Mission Control counts churn30 off live_status, and Insights
  // counts it off churn_log.died_at. So a hand-set verdict has to do all three things the lane
  // does, or the numbers drift apart — which is exactly the two-disagreeing-churn-figures bug
  // that scripts/lib/churn.mjs was created to stop.
  if ("live_status" in set) {
    set.live_checked_at = new Date();
    // Zero the miss counter either way. Going active, a lane's pending misses would otherwise
    // churn the store out on its very next check and silently undo this edit; going dead, the
    // count is a record of consecutive probe failures and a human verdict is not one of those.
    set.live_miss = 0;
  }
  // not_a_store needs its own stamp or scripts/reclassify-not-a-store.mjs undoes the tag on its
  // next pass (the same trap scripts/audit-nonstorefront-hosts.mjs documents).
  if (set.activity_tier === "not_a_store") set.not_a_store_checked_at = new Date();
  // A hand-set retail verdict outranks the local LLM's guess. text-mine.mjs queues on
  // `text_mined_at IS NULL`, so stamping it is all that is needed to stop the model revisiting
  // the store and overwriting the answer — the same trick as contact_checked_at above, using the
  // lane's own gate rather than a second override list.
  if ("physical_store" in set) set.text_mined_at = new Date();

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
      // Keep churn_log in step with the hand-set verdict, in the same transaction, so the two
      // churn figures can never disagree about a store an admin touched.
      if ("live_status" in set) {
        const nv = set.live_status as string | null;
        if (nv && TERMINAL.has(nv)) {
          // Same shape and the same died_at rule as scripts/verify-liveness.mjs: the death is
          // dated to the last time we confirmed the store SELLING, and is `historic` (excluded
          // from period churn) when we never did. First churn wins, as there.
          await q`
            INSERT INTO churn_log (domain, name, country, status, migrated_to, first_seen,
              discovered_at, category, theme, city, estimated_monthly_sales, payments,
              shipping_providers, free_shipping, plus, historic, died_at)
            SELECT domain, name, country, ${nv}, NULL, first_seen,
              discovered_at, category, theme, city, estimated_monthly_sales, payments,
              shipping_providers, free_shipping, plus, (first_verified_live_at IS NULL),
              last_alive_at
            FROM imported_stores WHERE domain = ${d}
            ON CONFLICT (domain) DO NOTHING`;
        } else if (cur.live_status && TERMINAL.has(String(cur.live_status))) {
          // Resurrecting a store an admin (or a lane) had written off. The churn row has to go
          // with it: leaving it would keep the store in Insights' churn for its died_at month
          // while Mission Control, reading live_status, no longer counts it. Audited below, so
          // the deletion is not silent.
          await q`DELETE FROM churn_log WHERE domain = ${d}`;
          audits.push({ field: "churn_log", old: `${cur.live_status} row`, new: "deleted (resurrected)" });
        }
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
