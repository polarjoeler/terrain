/** Store tags / cohorts — manual curation (Top 100, Top 1000, Partner Managed)
 *  an admin applies to stores. Powers the admin lead manager and tagged-cohort
 *  insights (e.g. "payment breakdown of the ZA Top 100"). */

import { db as sharedDb } from "./db";
import { PRESET_TAGS, tagLabel } from "./tag-defs";

export { PRESET_TAGS, tagLabel };

function db() {
  return sharedDb();
}
// Ensure the table exists ONCE per process, not on every call. This DDL takes a brief
// ACCESS EXCLUSIVE lock; running it on every request (tagCounts is on the insights hot path)
// added latency and a serialization point. Memoise the first success; reset on failure to retry.
let _ensured: Promise<void> | null = null;
function ensure(): Promise<void> {
  return (_ensured ??= db()`CREATE TABLE IF NOT EXISTS store_tags (
    domain TEXT NOT NULL, tag TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (domain, tag))`
    .then(() => {})
    .catch((e) => { _ensured = null; throw e; }));
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
