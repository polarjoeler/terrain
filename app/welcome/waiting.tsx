"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/** The gap between Stripe redirecting the customer and our webhook writing their subscribers
 *  row. It is usually imperceptible — the live cutover measured 7s from session to row, and the
 *  customer spends longer than that typing a card — but "usually" is not "always", and the
 *  failure we are guarding against is the silent one: webhook never fires, customer has paid,
 *  paywall bounces them.
 *
 *  So this re-renders the server component a bounded number of times and then STOPS, turning a
 *  genuine failure into a message a person can act on instead of a spinner that never resolves. */
export function WaitingForAccess({ email, tries = 10, everyMs = 3000 }: {
  email: string;
  tries?: number;
  everyMs?: number;
}) {
  const router = useRouter();
  const [left, setLeft] = useState(tries);

  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => {
      setLeft((n) => n - 1);
      router.refresh();
    }, everyMs);
    return () => clearTimeout(t);
  }, [left, everyMs, router]);

  if (left > 0) {
    return (
      <div className="mt-10 text-center">
        <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-cream/20 border-t-orange" />
        <p className="mt-4 text-cream/70">Setting up your account…</p>
        <p className="mt-1 text-sm text-cream/40">Your payment went through. This usually takes a second or two.</p>
      </div>
    );
  }

  return (
    <div className="mt-10 rounded-lg border border-orange/40 bg-orange/5 p-6 text-center">
      <p className="font-medium text-cream">Your payment went through, but your access hasn&apos;t switched on yet.</p>
      <p className="mt-2 text-sm text-cream/60">
        Nothing is lost and you have not been charged twice — this is on our side, not yours.
        Email <a className="underline underline-offset-2" href={`mailto:hello@heyterrain.com?subject=Access%20not%20active%20(${encodeURIComponent(email)})`}>hello@heyterrain.com</a> and
        we&apos;ll sort it out.
      </p>
      <p className="mt-3 text-xs text-cream/35">Signed up as {email}</p>
    </div>
  );
}
