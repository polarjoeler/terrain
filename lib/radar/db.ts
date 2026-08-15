/** Shared Postgres handle for the Radar modules (audits, fingerprints).
 *  Lazily connects and applies lib/schema.sql once per process. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

let _sql: ReturnType<typeof postgres> | null = null;
let _ready: Promise<void> | null = null;

export function db() {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL not set");
    _sql = postgres(url, { prepare: false, max: 3, idle_timeout: 20 });
  }
  return _sql;
}

export function ensureSchema(): Promise<void> {
  if (!_ready) {
    const ddl = readFileSync(join(process.cwd(), "lib", "schema.sql"), "utf8");
    _ready = db().unsafe(ddl).then(() => undefined);
  }
  return _ready;
}
