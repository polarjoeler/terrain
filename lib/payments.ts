/** Payment routing: Paystack for South Africa (ZAR), Stripe for other markets.
 *
 * MVP wiring: Paystack Payment Pages (create one per plan in the Paystack
 * dashboard, paste the URLs into .env). Stripe Checkout comes later via an
 * /api/checkout route when international markets open.
 */

export type Plan = "starter" | "pro";
export type Market = "ZA" | "INTL";

export const pricing: Record<Plan, { zar: number; label: string }> = {
  starter: { zar: 499, label: "Starter" },
  pro: { zar: 999, label: "Pro" },
};

export function checkoutUrl(plan: Plan, market: Market = "ZA"): string {
  if (market === "ZA") {
    const urls: Record<Plan, string | undefined> = {
      starter: process.env.NEXT_PUBLIC_PAYSTACK_STARTER_URL,
      pro: process.env.NEXT_PUBLIC_PAYSTACK_PRO_URL,
    };
    return urls[plan] ?? "#pricing";
  }
  // Stripe (international) — implemented when non-ZA markets launch.
  return "#pricing";
}
