/** Plan chooser AND paywall: (app)/layout.tsx redirects here the moment access lapses, the
 *  trial banner links here, and /account links here to change plan. It used to open with
 *  "Your trial has ended" regardless, which is wrong for three of those four arrivals — so
 *  the heading now follows the subscriber's actual status.
 *
 *  Prices and entitlements come from lib/plans.ts; nothing about the ladder is written here. */
import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { Wordmark } from "@/app/components/logo";
import { getSubscriber, hasAccess, trialDaysLeft } from "@/lib/subscriptions";
import { resolvePlan } from "@/lib/plans";
import { PlanPicker } from "./plan-picker";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Plans" };

export default async function Billing() {
  const email = await currentUser();
  const sub = email ? await getSubscriber(email).catch(() => null) : null;
  const days = trialDaysLeft(sub);
  const active = hasAccess(sub);

  const { heading, sub: subline } = !sub
    ? { heading: "Choose your plan", sub: "Every plan starts with a 7-day free trial." }
    : sub.status === "past_due"
      ? { heading: "Your payment didn't go through.", sub: "Update your card to keep your access — your data is untouched." }
      : days != null
        ? { heading: days === 0 ? "Your trial ends today." : `${days} day${days === 1 ? "" : "s"} left in your trial.`, sub: "Pick a plan to keep going — nothing changes until the trial ends." }
        : active
          ? { heading: "Your plan", sub: "Change tier at any time; we prorate the difference." }
          : { heading: "Your trial has ended.", sub: "Subscribe to keep receiving new stores as they launch." };

  return (
    <main className="flex min-h-screen flex-col items-center px-6 py-16">
      <Link href="/" className="mb-10 text-cream">
        <Wordmark size="text-2xl" tone="cream" />
      </Link>

      <div className="w-full max-w-5xl">
        <h1 className="text-center font-display text-4xl md:text-5xl">{heading}</h1>
        <p className="mt-3 text-center text-cream/60">{subline}</p>

        <PlanPicker currentPlan={sub ? resolvePlan(sub.plan) : undefined} />

        {active && (
          <p className="mt-6 text-center text-xs text-cream/35">
            <Link href="/account" className="underline-offset-2 hover:text-cream/60 hover:underline">Back to account &amp; workspace</Link>
          </p>
        )}
      </div>
    </main>
  );
}
