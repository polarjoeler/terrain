/** Paystack webhook receiver.
 *
 * SECURITY: this endpoint is public, so every request is verified against
 * HMAC-SHA512 of the RAW body using the secret key. Never parse-then-verify —
 * re-serialising JSON changes bytes and breaks the signature.
 *
 * Note charge.success fires for EVERY successful charge on the account, not
 * just subscription renewals, so we only act on it when a plan is attached.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { upsertSubscriber, type Status } from "@/lib/subscriptions";

export const runtime = "nodejs";

type PaystackEvent = {
  event: string;
  data: {
    status?: string;
    subscription_code?: string;
    email_token?: string;
    next_payment_date?: string | null;
    customer?: { email?: string; customer_code?: string };
    plan?: { plan_code?: string; name?: string } | string | null;
    plan_object?: { plan_code?: string; name?: string };
  };
};

function verify(raw: string, signature: string | null): boolean {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key || !signature) return false;
  const expected = createHmac("sha512", key).update(raw).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function planKeyFrom(name?: string): "starter" | "pro" | undefined {
  if (!name) return undefined;
  const n = name.toLowerCase();
  if (n.includes("pro")) return "pro";
  if (n.includes("starter")) return "starter";
  return undefined;
}

export async function POST(req: Request) {
  const raw = await req.text();

  if (!verify(raw, req.headers.get("x-paystack-signature"))) {
    // 401 (not 400) so Paystack's dashboard shows it as rejected, not malformed.
    return new NextResponse("invalid signature", { status: 401 });
  }

  let evt: PaystackEvent;
  try {
    evt = JSON.parse(raw);
  } catch {
    return new NextResponse("bad json", { status: 400 });
  }

  const email = evt.data?.customer?.email;
  const planName =
    typeof evt.data?.plan === "object" && evt.data.plan
      ? evt.data.plan.name
      : evt.data?.plan_object?.name;

  // Everything below is keyed on the customer email; without it there's nothing
  // to update. Still ack with 200 so Paystack doesn't retry forever.
  if (!email) return NextResponse.json({ received: true });

  const patch: Parameters<typeof upsertSubscriber>[1] = {};
  let status: Status | undefined;

  switch (evt.event) {
    case "subscription.create":
      status = "active";
      patch.subscriptionCode = evt.data.subscription_code;
      patch.emailToken = evt.data.email_token;
      patch.nextPaymentDate = evt.data.next_payment_date ?? null;
      break;

    case "charge.success":
      // Only a subscription charge matters here; one-off charges are ignored.
      if (!evt.data.plan && !evt.data.plan_object) {
        return NextResponse.json({ received: true, ignored: "non-subscription" });
      }
      status = "active";
      break;

    case "invoice.update":
      // Fires after a renewal is settled.
      if (evt.data.status === "success") status = "active";
      patch.nextPaymentDate = evt.data.next_payment_date ?? null;
      break;

    case "invoice.payment_failed":
      status = "past_due";
      break;

    case "subscription.not_renew":
      // Cancelled but paid up — access continues until the period ends.
      status = "cancelled";
      break;

    case "subscription.disable":
      status = "expired";
      break;

    default:
      return NextResponse.json({ received: true, ignored: evt.event });
  }

  if (status) patch.status = status;
  const planKey = planKeyFrom(planName);
  if (planKey) patch.plan = planKey;
  if (evt.data.customer?.customer_code) {
    patch.customerCode = evt.data.customer.customer_code;
  }

  await upsertSubscriber(email, patch);
  return NextResponse.json({ received: true, event: evt.event, status });
}
