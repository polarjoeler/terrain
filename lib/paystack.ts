/** Paystack client — plans, checkout, subscriptions.
 *
 * ZAR amounts are in CENTS everywhere in this file (R499 -> 49900). The API
 * takes the smallest currency unit; getting this wrong charges 100x.
 *
 * Trials: Paystack has no native trial field. Its `start_date` on a
 * subscription needs a saved card authorization, which means charging up front.
 * So the trial runs in our app (see lib/subscriptions.ts) and we only send a
 * customer to Paystack when they convert.
 */

const BASE = "https://api.paystack.co";

export type Interval = "daily" | "weekly" | "monthly" | "quarterly" | "annually";

function secret(): string {
  const k = process.env.PAYSTACK_SECRET_KEY;
  if (!k) throw new Error("PAYSTACK_SECRET_KEY is not set");
  return k;
}

async function api<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${secret()}`,
      "Content-Type": "application/json",
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  const json = (await res.json()) as { status: boolean; message: string; data: T };
  if (!res.ok || !json.status) {
    throw new Error(`paystack ${path} failed: ${json.message ?? res.status}`);
  }
  return json.data;
}

/* ---------------------------------------------------------------- plans --- */

export async function createPlan(opts: {
  name: string;
  amountCents: number;
  interval: Interval;
  description?: string;
}) {
  return api<{ plan_code: string; id: number; name: string; amount: number }>(
    "/plan",
    {
      method: "POST",
      body: {
        name: opts.name,
        amount: opts.amountCents,
        interval: opts.interval,
        currency: "ZAR",
        description: opts.description,
      },
    },
  );
}

export async function listPlans() {
  return api<Array<{ plan_code: string; name: string; amount: number; interval: string }>>(
    "/plan?perPage=100",
  );
}

/* ------------------------------------------------------------- checkout --- */

/** Start a subscription: passing `plan` makes the charge recurring.
 *  The plan's amount overrides any amount passed. */
export async function initializeSubscription(opts: {
  email: string;
  planCode: string;
  callbackUrl: string;
  metadata?: Record<string, unknown>;
}) {
  return api<{ authorization_url: string; access_code: string; reference: string }>(
    "/transaction/initialize",
    {
      method: "POST",
      body: {
        email: opts.email,
        plan: opts.planCode,
        callback_url: opts.callbackUrl,
        metadata: opts.metadata,
      },
    },
  );
}

export async function verifyTransaction(reference: string) {
  return api<{
    status: string;
    reference: string;
    amount: number;
    customer: { email: string; customer_code: string };
    plan?: string | null;
    plan_object?: { plan_code: string; name: string };
  }>(`/transaction/verify/${encodeURIComponent(reference)}`);
}

/* -------------------------------------------------------- subscriptions --- */

export async function getSubscription(codeOrId: string) {
  return api<{
    subscription_code: string;
    email_token: string;
    status: string;
    next_payment_date: string | null;
    customer: { email: string };
    plan: { plan_code: string; name: string; amount: number };
  }>(`/subscription/${encodeURIComponent(codeOrId)}`);
}

/** Cancel. Paystack needs BOTH the subscription code and its email_token. */
export async function disableSubscription(code: string, emailToken: string) {
  return api<unknown>("/subscription/disable", {
    method: "POST",
    body: { code, token: emailToken },
  });
}

/** Hosted page where the customer can update their card. */
export async function manageSubscriptionLink(code: string) {
  return api<{ link: string }>(`/subscription/${encodeURIComponent(code)}/manage/link`);
}
