/** Commit onboarding — "Launch my workspace". Writes the structured prefs + marks completion. */
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { completeOnboarding } from "@/lib/onboarding-store";
import type { OnboardingState } from "@/lib/onboarding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const email = await currentUser();
  if (!email) return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  let state: OnboardingState;
  try { state = (await req.json()) as OnboardingState; } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  if (!state?.companyType && state?.goals?.length === 0) {
    return NextResponse.json({ error: "Please complete at least your company and goals." }, { status: 400 });
  }
  try {
    await completeOnboarding(email, state);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[onboarding] complete failed:", e);
    return NextResponse.json({ error: "Could not save — please try again." }, { status: 500 });
  }
}
