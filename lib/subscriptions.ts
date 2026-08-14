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
  createdAt: string;
  updatedAt: string;
};

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
