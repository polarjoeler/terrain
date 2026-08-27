/** Signed share links for provider dashboards. A payment company gets a read-only
 *  URL (/p/<provider>?t=<token>) that works WITHOUT a login — the token is an HMAC
 *  over the provider name, so it grants access to exactly that one provider's page
 *  and nothing else. Same secret/scheme as lib/auth.ts. */

import { createHmac, timingSafeEqual } from "node:crypto";

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) throw new Error("AUTH_SECRET must be set (16+ chars)");
  return s;
}
const b64 = (v: string) => Buffer.from(v).toString("base64url");

export function signProviderToken(provider: string): string {
  const body = b64(JSON.stringify({ provider: provider.toLowerCase(), kind: "provider" }));
  const mac = createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifyProviderToken(provider: string, token: string | undefined): boolean {
  if (!token || !token.includes(".")) return false;
  const [body, mac] = token.split(".");
  const expected = createHmac("sha256", secret()).update(body).digest("base64url");
  const a = Buffer.from(mac, "utf8"), b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString()) as { provider: string; kind: string };
    return p.kind === "provider" && p.provider === provider.toLowerCase();
  } catch {
    return false;
  }
}
