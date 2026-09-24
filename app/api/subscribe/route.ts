/** Newsletter signup → Beehiiv. Called by the homepage CTAs (Africa + Japan).
 *
 *  Segments by market with a "Market" custom field (Africa / Japan) plus UTM campaign, so a single
 *  Beehiiv publication can send region-specific issues. Japan gets double opt-in (APPI). The
 *  "Market" custom field must exist in the publication (created via the API) or Beehiiv discards it;
 *  the utm_campaign tag is captured regardless, so segmentation survives even if the field is gone.
 *
 *  No-ops safely (still returns ok) when BEEHIIV_* env is unset, so the form works before the keys
 *  land — the signup is logged server-side rather than lost, and never errors the visitor. */

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PUB = process.env.BEEHIIV_PUBLICATION_ID;
const KEY = process.env.BEEHIIV_API_KEY;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function POST(req: Request) {
  let body: { email?: string; region?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const email = (body.email ?? "").trim().toLowerCase();
  const region = body.region === "japan" ? "Japan" : "Africa"; // default to Africa/global
  if (!EMAIL_RE.test(email)) return NextResponse.json({ error: "Enter a valid email." }, { status: 400 });

  if (!PUB || !KEY) {
    // Not wired yet — don't lose the signup or error the visitor; leave a trail for setup.
    console.warn(`[subscribe] Beehiiv not configured — captured ${email} (${region}) but not sent`);
    return NextResponse.json({ ok: true, stored: false });
  }

  try {
    const res = await fetch(`https://api.beehiiv.com/v2/publications/${PUB}/subscriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        reactivate_existing: false,
        send_welcome_email: true,
        utm_source: "heyterrain",
        utm_medium: "site",
        utm_campaign: region.toLowerCase(),
        double_opt_override: region === "Japan" ? "on" : "not_set",
        custom_fields: [{ name: "Market", value: region }],
      }),
    });
    if (!res.ok) {
      console.error(`[subscribe] beehiiv ${res.status}: ${await res.text()}`);
      return NextResponse.json({ error: "Couldn’t sign you up — please try again." }, { status: 502 });
    }
    return NextResponse.json({ ok: true, stored: true });
  } catch (e) {
    console.error("[subscribe] network", e);
    return NextResponse.json({ error: "Couldn’t sign you up — please try again." }, { status: 502 });
  }
}
