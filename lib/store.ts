/** Storage backend for subscriber state.
 *
 * Postgres when DATABASE_URL is set (required in production — serverless has an
 * ephemeral, per-instance filesystem, so the JSON fallback would silently lose
 * sessions and subscriptions). Falls back to a local JSON file for development.
 *
 * Both backends implement the same `Store` interface, so lib/subscriptions.ts
 * never knows which one it's talking to.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import type { Subscriber } from "./subscriptions";

export interface Store {
  get(email: string): Promise<Subscriber | null>;
  upsert(s: Subscriber): Promise<void>;
  wasTokenUsed(jti: string): Promise<boolean>;
  consumeToken(jti: string, expiresAt: number): Promise<void>;
  readonly kind: "postgres" | "file";
}

/* ------------------------------------------------------------- postgres --- */

function makePostgresStore(url: string): Store {
  const sql = postgres(url, {
    // Supabase's transaction pooler doesn't support prepared statements.
    prepare: false,
    max: 5,
    idle_timeout: 20,
  });

  let ready: Promise<void> | null = null;
  const ensure = () => {
    if (!ready) {
      const ddl = readFileSync(join(process.cwd(), "lib", "schema.sql"), "utf8");
      ready = sql.unsafe(ddl).then(() => undefined);
    }
    return ready;
  };

  const toSubscriber = (r: Record<string, unknown>): Subscriber => ({
    email: r.email as string,
    plan: r.plan as Subscriber["plan"],
    status: r.status as Subscriber["status"],
    trialEndsAt: r.trial_ends_at ? new Date(r.trial_ends_at as string).toISOString() : null,
    customerCode: (r.customer_code as string) ?? undefined,
    subscriptionCode: (r.subscription_code as string) ?? undefined,
    emailToken: (r.email_token as string) ?? undefined,
    nextPaymentDate: r.next_payment_date
      ? new Date(r.next_payment_date as string).toISOString()
      : null,
    exportMonth: (r.export_month as string) ?? null,
    exportUsed: (r.export_used as number) ?? 0,
    createdAt: new Date(r.created_at as string).toISOString(),
    updatedAt: new Date(r.updated_at as string).toISOString(),
  });

  return {
    kind: "postgres",

    async get(email) {
      await ensure();
      const rows = await sql`SELECT * FROM subscribers WHERE email = ${email}`;
      return rows[0] ? toSubscriber(rows[0]) : null;
    },

    async upsert(s) {
      await ensure();
      await sql`
        INSERT INTO subscribers (
          email, plan, status, trial_ends_at, customer_code,
          subscription_code, email_token, next_payment_date,
          export_month, export_used, created_at, updated_at
        ) VALUES (
          ${s.email}, ${s.plan}, ${s.status}, ${s.trialEndsAt}, ${s.customerCode ?? null},
          ${s.subscriptionCode ?? null}, ${s.emailToken ?? null}, ${s.nextPaymentDate ?? null},
          ${s.exportMonth ?? null}, ${s.exportUsed ?? 0},
          ${s.createdAt}, ${s.updatedAt}
        )
        ON CONFLICT (email) DO UPDATE SET
          plan              = EXCLUDED.plan,
          status            = EXCLUDED.status,
          trial_ends_at     = EXCLUDED.trial_ends_at,
          customer_code     = COALESCE(EXCLUDED.customer_code, subscribers.customer_code),
          subscription_code = COALESCE(EXCLUDED.subscription_code, subscribers.subscription_code),
          email_token       = COALESCE(EXCLUDED.email_token, subscribers.email_token),
          next_payment_date = EXCLUDED.next_payment_date,
          export_month      = EXCLUDED.export_month,
          export_used       = EXCLUDED.export_used,
          updated_at        = EXCLUDED.updated_at
      `;
    },

    async wasTokenUsed(jti) {
      await ensure();
      const rows = await sql`SELECT 1 FROM used_tokens WHERE jti = ${jti}`;
      return rows.length > 0;
    },

    async consumeToken(jti, expiresAt) {
      await ensure();
      await sql`DELETE FROM used_tokens WHERE expires_at < now()`;
      await sql`
        INSERT INTO used_tokens (jti, expires_at)
        VALUES (${jti}, ${new Date(expiresAt).toISOString()})
        ON CONFLICT (jti) DO NOTHING
      `;
    },
  };
}

/* ----------------------------------------------------------------- file --- */

function makeFileStore(): Store {
  const dataFile =
    process.env.SUBSCRIBERS_FILE ?? join(process.cwd(), ".data", "subscribers.json");
  const tokensFile = join(dirname(dataFile), "used-tokens.json");

  const readJson = async <T>(p: string, fallback: T): Promise<T> => {
    try {
      return JSON.parse(await readFile(p, "utf8")) as T;
    } catch {
      return fallback;
    }
  };
  const writeJson = async (p: string, v: unknown) => {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(v, null, 2), "utf8");
  };

  return {
    kind: "file",

    async get(email) {
      const all = await readJson<Record<string, Subscriber>>(dataFile, {});
      return all[email] ?? null;
    },

    async upsert(s) {
      const all = await readJson<Record<string, Subscriber>>(dataFile, {});
      all[s.email] = s;
      await writeJson(dataFile, all);
    },

    async wasTokenUsed(jti) {
      const all = await readJson<Record<string, number>>(tokensFile, {});
      return jti in all;
    },

    async consumeToken(jti, expiresAt) {
      const all = await readJson<Record<string, number>>(tokensFile, {});
      const now = Date.now();
      for (const [k, exp] of Object.entries(all)) if (exp < now) delete all[k];
      all[jti] = expiresAt;
      await writeJson(tokensFile, all);
    },
  };
}

/* --------------------------------------------------------------- select --- */

let cached: Store | null = null;

export function getStore(): Store {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (url) {
    cached = makePostgresStore(url);
  } else {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[terrain] DATABASE_URL is not set — using the file store. " +
          "This WILL lose data on serverless hosting.",
      );
    }
    cached = makeFileStore();
  }
  return cached;
}
