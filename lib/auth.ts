/** Passwordless auth: signed magic-link tokens + a signed session cookie.
 *
 * No third-party auth provider and no extra dependency — tokens are HMAC-SHA256
 * signed payloads verified with a timing-safe compare.
 *
 * Magic-link tokens are short-lived (15 min) and single-use: a used token's id
 * is recorded so a link forwarded or replayed from an inbox can't be reused.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";
import { consumeToken, wasTokenUsed } from "./subscriptions";

/** Share the session across *.tembocommerce.app (Terrain + Radar subdomains) by
 *  scoping the cookie to the parent domain. Host-only (undefined) on localhost
 *  and *.vercel.app previews, where a parent-domain cookie would be rejected. */
async function sessionCookieDomain(): Promise<string | undefined> {
  try {
    const host = ((await headers()).get("host") ?? "").split(":")[0];
    if (host.endsWith("tembocommerce.app")) return ".tembocommerce.app";
  } catch {
    /* headers() unavailable (e.g. non-request context) */
  }
  return undefined;
}

export const SESSION_COOKIE = "terrain_session";
const LINK_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 864e5;

function authSecret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) {
    throw new Error("AUTH_SECRET must be set to a random string of 16+ chars");
  }
  return s;
}

const b64 = (v: string | Buffer) => Buffer.from(v).toString("base64url");

type Payload = { email: string; exp: number; jti: string; kind: "link" | "session" };

function sign(payload: Payload): string {
  const body = b64(JSON.stringify(payload));
  const mac = createHmac("sha256", authSecret()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function unsign(token: string | undefined): Payload | null {
  if (!token || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  const expected = createHmac("sha256", authSecret()).update(body).digest("base64url");
  const a = Buffer.from(mac, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as Payload;
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------- magic links --- */

/** The public origin the request actually came in on (radar or terrain host),
 *  so magic links + post-login redirects stay on the host the user is using. */
export function originFromRequest(req: Request): string {
  const h = req.headers;
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (host) return `${h.get("x-forwarded-proto") ?? "https"}://${host}`;
  return process.env.NEXT_PUBLIC_SITE_URL ?? new URL(req.url).origin;
}

/** Is this request on the Radar host? (drives Radar-branded login + redirects) */
export function isRadarHost(req: Request): boolean {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  return host.startsWith("radar.");
}

export function createMagicToken(email: string): string {
  return sign({
    email: email.trim().toLowerCase(),
    exp: Date.now() + LINK_TTL_MS,
    jti: randomBytes(12).toString("hex"),
    kind: "link",
  });
}

/** Verify and burn a magic token. Returns the email, or null if invalid/reused. */
export async function redeemMagicToken(token: string): Promise<string | null> {
  const payload = unsign(token);
  if (!payload || payload.kind !== "link") return null;
  if (await wasTokenUsed(payload.jti)) return null;
  await consumeToken(payload.jti, payload.exp);
  return payload.email;
}

/* ------------------------------------------------------------ sessions --- */

export async function startSession(email: string): Promise<void> {
  const token = sign({
    email: email.trim().toLowerCase(),
    exp: Date.now() + SESSION_TTL_MS,
    jti: randomBytes(8).toString("hex"),
    kind: "session",
  });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
    domain: await sessionCookieDomain(),
  });
}

export async function endSession(): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, "", {
    httpOnly: true,
    path: "/",
    maxAge: 0,
    domain: await sessionCookieDomain(),
  });
}

/** Email of the signed-in user, or null. */
export async function currentUser(): Promise<string | null> {
  const jar = await cookies();
  const payload = unsign(jar.get(SESSION_COOKIE)?.value);
  return payload && payload.kind === "session" ? payload.email : null;
}

/** Owner/admin check — ADMIN_EMAILS is a comma-separated allowlist. */
export function isAdmin(email: string | null): boolean {
  if (!email) return false;
  const admins = (process.env.ADMIN_EMAILS ?? "joelbronkowski@gmail.com")
    .split(",")
    .map((s) => s.trim().toLowerCase());
  return admins.includes(email.toLowerCase());
}
