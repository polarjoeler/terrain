/** Subscriber state, driven by Stripe.
 *
 * Persistence lives in lib/store.ts — Postgres when DATABASE_URL is set, a JSON
 * file otherwise. Nothing here knows or cares which. Access follows the Stripe
 * subscription status, updated by the Stripe webhook.
 */

import { getStore } from "./store";

export const TRIAL_DAYS = 7;

export type PlanKey = "starter" | "pro";
export type Status = "trialing" | "active" | "past_due" | "cancelled" | "expired";

export type Subscriber = {
  email: string;
  plan: PlanKey;
  status: Status;
  trialEndsAt: string | null;
  /** Stripe identifiers (customerCode = customer id, subscriptionCode = sub id). */
  customerCode?: string;
  subscriptionCode?: string;
  emailToken?: string;
  nextPaymentDate?: string | null;
  /** Monthly CSV-export quota (Pro). */
  exportMonth?: string | null; // 'YYYY-MM'
  exportUsed?: number;
  createdAt: string;
  updatedAt: string;
};

export const EXPORT_LIMIT_PRO = 200;

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

/** Remaining export allowance this month (0 for non-Pro). */
export function exportQuota(s: Subscriber | null): {
  used: number;
  limit: number;
  remaining: number;
} {
  const limit = s && s.plan === "pro" ? EXPORT_LIMIT_PRO : 0;
  const used = s && s.exportMonth === currentMonth() ? s.exportUsed ?? 0 : 0;
  return { used, limit, remaining: Math.max(0, limit - used) };
}

/** Try to consume `n` export rows. Server-enforced; resets on month rollover. */
export async function consumeExportQuota(
  email: string,
  n: number,
): Promise<{ ok: boolean; remaining: number; limit: number; reason?: string }> {
  const s = await getSubscriber(email);
  if (!s || s.plan !== "pro" || !hasAccess(s)) {
    return { ok: false, remaining: 0, limit: 0, reason: "Export is a Pro feature." };
  }
  const month = currentMonth();
  const used = s.exportMonth === month ? s.exportUsed ?? 0 : 0;
  if (used + n > EXPORT_LIMIT_PRO) {
    return {
      ok: false,
      remaining: EXPORT_LIMIT_PRO - used,
      limit: EXPORT_LIMIT_PRO,
      reason: `Monthly export limit reached (${EXPORT_LIMIT_PRO}/mo).`,
    };
  }
  await upsertSubscriber(email, { exportMonth: month, exportUsed: used + n });
  return { ok: true, remaining: EXPORT_LIMIT_PRO - used - n, limit: EXPORT_LIMIT_PRO };
}

const key = (email: string) => email.trim().toLowerCase();

export async function getSubscriber(email: string): Promise<Subscriber | null> {
  return getStore().get(key(email));
}

export async function upsertSubscriber(
  email: string,
  patch: Partial<Subscriber>,
): Promise<Subscriber> {
  const store = getStore();
  const k = key(email);
  const existing = await store.get(k);
  const now = new Date().toISOString();

  const next: Subscriber = {
    email: k,
    plan: patch.plan ?? existing?.plan ?? "starter",
    status: patch.status ?? existing?.status ?? "trialing",
    trialEndsAt: patch.trialEndsAt ?? existing?.trialEndsAt ?? null,
    customerCode: patch.customerCode ?? existing?.customerCode,
    subscriptionCode: patch.subscriptionCode ?? existing?.subscriptionCode,
    emailToken: patch.emailToken ?? existing?.emailToken,
    nextPaymentDate: patch.nextPaymentDate ?? existing?.nextPaymentDate ?? null,
    exportMonth: patch.exportMonth ?? existing?.exportMonth ?? null,
    exportUsed: patch.exportUsed ?? existing?.exportUsed ?? 0,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await store.upsert(next);
  return next;
}

/* ------------------------------------------- single-use magic-link tokens --- */

export async function wasTokenUsed(jti: string): Promise<boolean> {
  return getStore().wasTokenUsed(jti);
}

export async function consumeToken(jti: string, expiresAt: number): Promise<void> {
  return getStore().consumeToken(jti, expiresAt);
}

/* ---------------------------------------------------------------- access --- */

/** True while the account may see lead data. */
export function hasAccess(s: Subscriber | null): boolean {
  if (!s) return false;
  if (s.status === "active") return true;
  if (s.status === "trialing") {
    return !!s.trialEndsAt && new Date(s.trialEndsAt) > new Date();
  }
  // past_due keeps access briefly so a failed card doesn't instantly lock out.
  return s.status === "past_due";
}

export function trialDaysLeft(s: Subscriber | null): number | null {
  if (!s || s.status !== "trialing" || !s.trialEndsAt) return null;
  const ms = new Date(s.trialEndsAt).getTime() - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / 864e5);
}
