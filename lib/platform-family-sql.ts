/** The SQL form of `platformFamily`, for the queries that read migrations straight out of the
 *  table.
 *
 *  It lives in its own module, not in platform-canon.ts, because that file is imported by the
 *  pipeline scripts through Node's type stripping (e.g. scripts/detect-builders.mjs) and must stay
 *  free of dependencies — importing ./db there would pull postgres and the DATABASE_URL assertions
 *  into a DNS-only script.
 *
 *  WORDPRESS_FAMILY is shared with the TypeScript helpers so the two forms cannot drift, which is
 *  the whole bug class this exists to close: the same fact derived independently in several places.
 */
import type { TransactionSql } from "postgres";
import type { db } from "./db";
import { WORDPRESS_FAMILY } from "./platform-canon";

/** `column` is a closed union, never caller-supplied text. `fallback` stands in for a NULL — the
 *  migration readers treat a store with no recorded platform as Shopify.
 *
 *  Takes a transaction handle as well as the pool: lib/platforms-report.ts builds its flows inside
 *  sql.begin(), and a fragment has to be made by the same handle that runs the query. */
export function platformFamilySql(
  sql: ReturnType<typeof db> | TransactionSql,
  column: "platform" | "live_platform" | "migrated_from",
  fallback: string | null = null,
) {
  const col = sql.unsafe(column);
  return sql`CASE
    WHEN lower(COALESCE(${col}, ${fallback})) = ANY(${WORDPRESS_FAMILY}) THEN 'wordpress'
    ELSE lower(COALESCE(${col}, ${fallback}))
  END`;
}
