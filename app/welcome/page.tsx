/** Post-checkout confirmation. Stripe's success_url lands here.
 *
 *  Deliberately OUTSIDE the (app) route group. That group's layout enforces the paywall, and
 *  there is a window between Stripe redirecting a customer and our webhook writing their
 *  subscribers row where a paying customer still has no access — rendering this inside the
 *  group would bounce them to /billing seconds after they paid, which is the exact experience
 *  this page exists to prevent. /billing sits outside the group for the same reason.
 *
 *  Two sources of truth, on purpose: Stripe says whether the money side completed, our own
 *  subscribers row says whether access landed. Keeping them separate is what turns a silent
 *  webhook failure into something the customer can see and act on, instead of a mystery paywall.
 *  Before this page existed, success_url pointed at /dashboard?welcome=1 and nothing anywhere
 *  read that flag, so a completed purchase and a failed one looked identical from the outside. */
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { Wordmark } from "@/app/components/logo";
import { getSubscriber, hasAccess, trialDaysLeft } from "@/lib/subscriptions";
import { planOf } from "@/lib/plans";
import { stripe } from "@/lib/stripe";
import { WaitingForAccess } from "./waiting";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — You're in" };

/** The address Stripe billed. Used ONLY when the visitor isn't signed in, because checkout can
 *  be started from the pricing page without an account. Never used to grant anything —
 *  entitlement still comes from the subscribers row via hasAccess(). */
async function emailFromSession(sessionId: string | undefined): Promise<string | null> {
  if (!sessionId?.startsWith("cs_")) return null;
  try {
    const s = await stripe().checkout.sessions.retrieve(sessionId);
    if (s.status !== "complete") return null;
    return s.customer_email ?? s.customer_details?.email ?? null;
  } catch {
    return null;                    // unknown or foreign session id — treat as no information
  }
}

const money = (usd: number) => `$${usd.toLocaleString("en-US")}`;

function longDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

export default async function Welcome({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string }>;
}) {
  const { session_id } = await searchParams;
  // Prefer the signed-in identity. The session is only a fallback, so a shared or guessed
  // session_id can never surface someone else's billing details to a signed-in visitor.
  const signedIn = await currentUser();
  const email = signedIn ?? (await emailFromSession(session_id));

  // Nothing to confirm, and nobody to confirm it for.
  if (!email) redirect("/billing");

  const sub = await getSubscriber(email).catch(() => null);
  const live = hasAccess(sub);
  const plan = planOf(sub?.plan);
  const days = trialDaysLeft(sub);
  const trialEnds = longDate(sub?.trialEndsAt);
  const seats = plan.seats + (sub?.extraSeats ?? 0);

  return (
    <main className="flex min-h-screen flex-col items-center px-6 py-16">
      <Link href="/" className="mb-10 text-cream">
        <Wordmark size="text-2xl" tone="cream" />
      </Link>

      <div className="w-full max-w-xl">
        {live ? (
          <>
            <h1 className="text-center font-display text-4xl md:text-5xl">You&apos;re in.</h1>
            <p className="mt-3 text-center text-cream/60">
              {sub?.status === "trialing"
                ? `Your ${plan.label} trial is live${days != null ? ` — ${days} day${days === 1 ? "" : "s"} to run` : ""}.`
                : `Your ${plan.label} subscription is live.`}
            </p>

            <dl className="mt-10 divide-y divide-cream/10 rounded-lg border border-cream/15 bg-cream/[0.03]">
              <div className="flex items-baseline justify-between px-5 py-4">
                <dt className="text-cream/50">Plan</dt>
                <dd className="font-medium text-cream">{plan.label}</dd>
              </div>
              <div className="flex items-baseline justify-between px-5 py-4">
                <dt className="text-cream/50">Seats</dt>
                <dd className="text-cream">{seats}</dd>
              </div>
              <div className="flex items-baseline justify-between px-5 py-4">
                <dt className="text-cream/50">Platforms</dt>
                <dd className="text-cream">{plan.platforms ? plan.platforms.join(", ") : "Every platform"}</dd>
              </div>
              <div className="flex items-baseline justify-between px-5 py-4">
                <dt className="text-cream/50">CSV exports</dt>
                <dd className="text-cream">{plan.exportLimit == null ? "Unlimited" : `${plan.exportLimit.toLocaleString("en-US")}/month`}</dd>
              </div>
              {trialEnds && (
                <div className="flex items-baseline justify-between px-5 py-4">
                  <dt className="text-cream/50">{sub?.status === "trialing" ? "Free until" : "Next payment"}</dt>
                  <dd className="text-cream">{trialEnds}</dd>
                </div>
              )}
            </dl>

            {sub?.status === "trialing" && trialEnds && (
              <p className="mt-4 text-center text-sm text-cream/45">
                You haven&apos;t been charged. Your card is billed {money(plan.monthlyUsd)} on {trialEnds} unless
                you tell us otherwise — email{" "}
                <a className="underline underline-offset-2 hover:text-cream/70" href="mailto:hello@heyterrain.com">hello@heyterrain.com</a>.
              </p>
            )}

            <div className="mt-10 text-center">
              <Link
                href="/dashboard"
                className="inline-block rounded-md bg-orange px-6 py-3 font-medium text-cream transition hover:opacity-90"
              >
                Start exploring stores
              </Link>
              <p className="mt-4 text-xs text-cream/35">
                <Link href="/account" className="underline-offset-2 hover:text-cream/60 hover:underline">
                  Account &amp; workspace
                </Link>
              </p>
            </div>
          </>
        ) : (
          <>
            <h1 className="text-center font-display text-4xl md:text-5xl">Thanks — almost there.</h1>
            <WaitingForAccess email={email} />
          </>
        )}
      </div>
    </main>
  );
}
