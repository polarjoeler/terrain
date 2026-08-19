/** Start a Radar monitoring subscription checkout. Returns the hosted Stripe
 *  Checkout URL. Keyed to a brand (by domain) via subscription metadata. */

import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { createRadarCheckoutSession } from "@/lib/stripe";
import { cleanDomain } from "@/lib/radar/catalog";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function POST(req: Request) {
  let body: { brandDomain?: string; email?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const brandDomain = cleanDomain(body.brandDomain ?? "");
  if (!brandDomain || !brandDomain.includes(".")) {
    return NextResponse.json({ error: "Missing brand domain" }, { status: 400 });
  }

  // Email is optional — if we know it (signed in / passed), prefill Stripe;
  // otherwise Stripe Checkout collects it. The subscription is keyed to the
  // brand via metadata, so email isn't required to attribute it.
  const candidate = ((await currentUser()) ?? body.email ?? "").trim().toLowerCase();
  const email = EMAIL_RE.test(candidate) ? candidate : undefined;

  // Radar lives on its own host; keep checkout returns there.
  const origin = process.env.RADAR_SITE_URL ?? "https://radar.tembocommerce.app";

  try {
    const url = await createRadarCheckoutSession({ email, brandDomain, origin });
    return NextResponse.json({ url });
  } catch (err) {
    console.error("[radar] checkout failed:", err);
    const msg = err instanceof Error ? err.message : "Could not start checkout";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
