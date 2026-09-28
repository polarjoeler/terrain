/** Shared Postgres handle for the Radar modules (audits, fingerprints).
 *  Lazily connects and applies lib/schema.sql once per process. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db as sharedDb } from "../db";

let _ready: Promise<void> | null = null;

export function db() {
  return sharedDb();
}

export function ensureSchema(): Promise<void> {
  if (!_ready) {
    const ddl = readFileSync(join(process.cwd(), "lib", "schema.sql"), "utf8");
    _ready = db().unsafe(ddl).then(() => undefined);
  }
  return _ready;
}
