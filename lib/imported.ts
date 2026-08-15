/** Admin-imported "base" stores — a separate pool from the live discovery feed.
 *
 * Uploaded via /admin, held with published=false until an admin publishes them.
 * Published rows are merged into the dashboard feed by lib/sheets.fetchLeads.
 * Postgres-backed (the base can be large; no Sheet cell-cap risk).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import type { Lead } from "./leads";

let _sql: ReturnType<typeof postgres> | null = null;
let _ready: Promise<void> | null = null;

function db() {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL not set");
    _sql = postgres(url, { prepare: false, max: 3, idle_timeout: 20 });
  }
  return _sql;
}
function ensure() {
  if (!_ready) {
    const ddl = readFileSync(join(process.cwd(), "lib", "schema.sql"), "utf8");
    _ready = db().unsafe(ddl).then(() => undefined);
  }
  return _ready;
}

/* ---- CSV parsing (RFC-4180-ish: quotes, embedded commas/newlines) --------- */

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  const t = text.replace(/\r\n?/g, "\n");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inQuotes) {
      if (c === '"') {
        if (t[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false;
      } else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

// Map flexible CSV headers to our fields.
const ALIASES: Record<string, string> = {
  domain: "domain", url: "domain", website: "domain", store: "domain",
  name: "name", "store name": "name", title: "name",
  country: "country", market: "country",
  email: "email", "contact email": "email",
  products: "product_count", "product count": "product_count", product_count: "product_count",
  "price min": "price_min", price_min: "price_min",
  "price max": "price_max", price_max: "price_max",
  currency: "currency",
  theme: "theme",
  plus: "plus", "shopify plus": "plus",
  payments: "payments", "payment providers": "payments",
  "first product": "first_product_at", first_product_at: "first_product_at",
  "first seen": "first_seen", first_seen: "first_seen",
};

const cleanDomain = (v: string) =>
  v.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");

export type ImportResult = { inserted: number; skipped: number; total: number };

export async function importCsv(text: string, source = "csv"): Promise<ImportResult> {
  await ensure();
  const rows = parseCsv(text);
  if (rows.length < 2) return { inserted: 0, skipped: 0, total: 0 };

  const header = rows[0].map((h) => ALIASES[h.trim().toLowerCase()] ?? "");
  const di = header.indexOf("domain");
  if (di === -1) throw new Error("CSV needs a 'domain' (or url/website) column");

  let inserted = 0, skipped = 0;
  for (const r of rows.slice(1)) {
    const domain = cleanDomain(r[di] ?? "");
    if (!domain || !domain.includes(".")) { skipped++; continue; }
    const get = (field: string) => {
      const idx = header.indexOf(field);
      return idx >= 0 ? (r[idx] ?? "").trim() : "";
    };
    const num = (s: string) => (s && !Number.isNaN(Number(s)) ? Number(s) : null);
    const plus = /^(true|yes|1|plus)$/i.test(get("plus"));
    await db()`
      INSERT INTO imported_stores (
        domain, name, country, product_count, price_min, price_max, currency,
        email, theme, plus, payments, first_product_at, first_seen, source, published
      ) VALUES (
        ${domain}, ${get("name") || null}, ${get("country").toUpperCase() || null},
        ${num(get("product_count"))}, ${num(get("price_min"))}, ${num(get("price_max"))},
        ${get("currency") || null}, ${get("email") || null}, ${get("theme") || null},
        ${plus}, ${get("payments") || null}, ${get("first_product_at") || null},
        ${get("first_seen") || null}, ${source}, false
      )
      ON CONFLICT (domain) DO NOTHING
    `;
    inserted++;
  }
  return { inserted, skipped, total: rows.length - 1 };
}

export async function counts(): Promise<{ pending: number; published: number }> {
  await ensure();
  const r = await db()`
    SELECT
      count(*) FILTER (WHERE NOT published)::int AS pending,
      count(*) FILTER (WHERE published)::int AS published
    FROM imported_stores`;
  return { pending: r[0].pending, published: r[0].published };
}

export async function listPending(limit = 20): Promise<{ domain: string; name: string | null }[]> {
  await ensure();
  const r = await db()`
    SELECT domain, name FROM imported_stores WHERE NOT published
    ORDER BY created_at DESC LIMIT ${limit}`;
  return r.map((x) => ({ domain: x.domain as string, name: (x.name as string) ?? null }));
}

export async function publishPending(): Promise<number> {
  await ensure();
  const r = await db()`
    UPDATE imported_stores SET published = true WHERE NOT published RETURNING domain`;
  return r.length;
}

export async function clearPending(): Promise<number> {
  await ensure();
  const r = await db()`DELETE FROM imported_stores WHERE NOT published RETURNING domain`;
  return r.length;
}

/** Published imported stores as Lead[], to merge into the dashboard feed. */
export type Liveness = {
  total: number;
  checked: number;
  active: number;
  migrated: number;
  dead: number;
  survival: number | null; // % of checked stores still live
};

/** Verified-liveness / churn summary of the imported SA store base. */
export async function importedLiveness(): Promise<Liveness> {
  await ensure();
  const [r] = await db()`
    SELECT
      COUNT(*)::int total,
      COUNT(*) FILTER (WHERE live_checked_at IS NOT NULL)::int checked,
      COUNT(*) FILTER (WHERE live_status = 'active')::int active,
      COUNT(*) FILTER (WHERE live_status = 'migrated')::int migrated,
      COUNT(*) FILTER (WHERE live_status = 'dead')::int dead
    FROM imported_stores WHERE published`;
  const checked = Number(r?.checked ?? 0);
  const active = Number(r?.active ?? 0);
  return {
    total: Number(r?.total ?? 0),
    checked,
    active,
    migrated: Number(r?.migrated ?? 0),
    dead: Number(r?.dead ?? 0),
    survival: checked ? Math.round((100 * active) / checked) : null,
  };
}

export async function publishedLeads(): Promise<Lead[]> {
  await ensure();
  // Explicit columns only — never SELECT * here: the `raw` jsonb is large and
  // this runs on every dashboard/homepage load.
  const rows = await db()`
    SELECT domain, name, product_count, price_min, price_max, email,
           first_product_at, plus, first_seen, country, currency, payments, theme
    FROM imported_stores
    WHERE published
      -- Exclude verified-dead / migrated-off-Shopify stores: they aren't leads.
      AND (live_status IS NULL OR live_status NOT IN ('dead', 'migrated'))
    ORDER BY estimated_monthly_sales DESC NULLS LAST, created_at DESC`;
  return rows.map((r) => ({
    domain: r.domain as string,
    name: (r.name as string) ?? (r.domain as string),
    productCount: (r.product_count as number) ?? null,
    priceMin: r.price_min != null ? Number(r.price_min) : null,
    priceMax: r.price_max != null ? Number(r.price_max) : null,
    email: (r.email as string) ?? null,
    firstProductAt: (r.first_product_at as string) ?? null,
    plus: Boolean(r.plus),
    firstSeen: (r.first_seen as string) ?? "",
    country: (r.country as string) ?? null,
    currency: (r.currency as string) ?? null,
    payments: r.payments ? (r.payments as string).split(";").filter(Boolean) : [],
    theme: (r.theme as string) ?? null,
    finalUrl: null,
  }));
}
