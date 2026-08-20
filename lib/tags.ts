/** Store tags / cohorts — manual curation (Top 100, Top 1000, Partner Managed)
 *  an admin applies to stores. Powers the admin lead manager and tagged-cohort
 *  insights (e.g. "payment breakdown of the ZA Top 100"). */

import postgres from "postgres";
import { PRESET_TAGS, tagLabel } from "./tag-defs";

export { PRESET_TAGS, tagLabel };

let _sql: ReturnType<typeof postgres> | null = null;
function db() {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL not set");
    _sql = postgres(url, { prepare: false, max: 3, idle_timeout: 20 });
  }
  return _sql;
}
async function ensure() {
  await db()`CREATE TABLE IF NOT EXISTS store_tags (
    domain TEXT NOT NULL, tag TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (domain, tag))`;
}

/** All distinct tags in use, with counts (preset order first). */
export async function tagCounts(): Promise<{ tag: string; count: number }[]> {
  await ensure();
  const rows = await db()<{ tag: string; n: number }[]>`
    SELECT tag, COUNT(*)::int n FROM store_tags GROUP BY tag`;
  const map = new Map(rows.map((r) => [r.tag, Number(r.n)]));
  const preset = PRESET_TAGS.map((t) => ({ tag: t.key, count: map.get(t.key) ?? 0 }));
  const extra = [...map.keys()].filter((t) => !PRESET_TAGS.some((p) => p.key === t))
    .map((t) => ({ tag: t, count: map.get(t)! }));
  return [...preset, ...extra];
}

/** domain -> tags[] for a set of domains. */
export async function tagsForDomains(domains: string[]): Promise<Record<string, string[]>> {
  if (!domains.length) return {};
  await ensure();
  const rows = await db()<{ domain: string; tag: string }[]>`
    SELECT domain, tag FROM store_tags WHERE domain = ANY(${db().array(domains)})`;
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[r.domain] ??= []).push(r.tag);
  return out;
}

/** Add or remove a tag across one or more domains. Returns the affected count. */
export async function setTag(domains: string[], tag: string, on: boolean): Promise<number> {
  const clean = domains.map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (!clean.length || !tag) return 0;
  await ensure();
  if (on) {
    const rows = clean.map((domain) => ({ domain, tag }));
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      await db()`INSERT INTO store_tags ${db()(batch, "domain", "tag")} ON CONFLICT DO NOTHING`;
    }
    return clean.length;
  }
  const r = await db()`DELETE FROM store_tags WHERE tag = ${tag} AND domain = ANY(${db().array(clean)}) RETURNING domain`;
  return r.length;
}

/** Domains carrying a tag (for the tagged-insights filter). */
export async function domainsWithTag(tag: string): Promise<string[]> {
  await ensure();
  const rows = await db()<{ domain: string }[]>`SELECT domain FROM store_tags WHERE tag = ${tag}`;
  return rows.map((r) => r.domain);
}
