/** Anti-sharing: track where each seat signs in from, and gate the sensitive action (bulk
 *  export) on concurrent-device count. Password/access sharing shows up as one email signing
 *  in from many IPs at once — a legit single user has a few devices, a shared login has many.
 *
 *  We record a row per LOGIN (email, ip, ua) and derive "distinct IPs in the last 24h". The
 *  export route blocks when that exceeds a cap, and every export is watermarked + logged, so
 *  a leaked CSV is traceable to the seat. Detection precedes hard lockout by design.
 */
import postgres from "postgres";

let _sql: ReturnType<typeof postgres> | null = null;
function db() {
  if (!_sql) _sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 3, idle_timeout: 20 });
  return _sql;
}

// Distinct sign-in IPs allowed per account within the window before the export action is gated.
export const CONCURRENT_IP_CAP = parseInt(process.env.SEAT_IP_CAP || "5", 10);

export function ipOf(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  return (xff ? xff.split(",")[0] : req.headers.get("x-real-ip") || "").trim() || "unknown";
}

async function ensure(sql: ReturnType<typeof db>) {
  await sql`CREATE TABLE IF NOT EXISTS login_events (
    id bigserial PRIMARY KEY, email text NOT NULL, ip text, ua text,
    at timestamptz NOT NULL DEFAULT now())`;
  await sql`CREATE TABLE IF NOT EXISTS export_log (
    id bigserial PRIMARY KEY, email text NOT NULL, export_id text, rows int, ip text,
    at timestamptz NOT NULL DEFAULT now())`;
}

/** Record a sign-in. Best-effort — never block auth on a logging failure. */
export async function recordLogin(email: string, ip: string, ua: string): Promise<void> {
  try {
    const sql = db(); await ensure(sql);
    await sql`INSERT INTO login_events (email, ip, ua) VALUES (${email.toLowerCase()}, ${ip}, ${ua.slice(0, 300)})`;
  } catch { /* logging must never break login */ }
}

/** Distinct sign-in IPs for this account within the last `hours`. */
export async function distinctLoginIps(email: string, hours = 24): Promise<number> {
  try {
    const sql = db(); await ensure(sql);
    const [r] = await sql`SELECT count(DISTINCT ip)::int n FROM login_events
      WHERE email = ${email.toLowerCase()} AND ip <> 'unknown' AND at > now() - (${hours}::int * interval '1 hour')`;
    return Number(r?.n ?? 0);
  } catch { return 0; }
}

/** Gate for the sensitive action: too many concurrent devices ⇒ likely a shared login. */
export async function sharingGate(email: string): Promise<{ ok: boolean; ips: number; cap: number }> {
  const ips = await distinctLoginIps(email, 24);
  return { ok: ips <= CONCURRENT_IP_CAP, ips, cap: CONCURRENT_IP_CAP };
}

export async function logExport(email: string, exportId: string, rows: number, ip: string): Promise<void> {
  try {
    const sql = db(); await ensure(sql);
    await sql`INSERT INTO export_log (email, export_id, rows, ip) VALUES (${email.toLowerCase()}, ${exportId}, ${rows}, ${ip})`;
  } catch { /* best-effort */ }
}

/** Accounts signing in from many IPs — the sharing watchlist for /ops or admin. */
export type SharingSignal = { email: string; ips: number; logins: number };
export async function sharingWatchlist(minIps = CONCURRENT_IP_CAP): Promise<SharingSignal[]> {
  try {
    const sql = db(); await ensure(sql);
    const rows = await sql`
      SELECT email, count(DISTINCT ip)::int ips, count(*)::int logins FROM login_events
      WHERE at > now() - interval '24 hours' AND ip <> 'unknown'
      GROUP BY email HAVING count(DISTINCT ip) >= ${minIps} ORDER BY 2 DESC`;
    return rows.map((r) => ({ email: r.email, ips: Number(r.ips), logins: Number(r.logins) }));
  } catch { return []; }
}
