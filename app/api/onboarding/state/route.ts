/** Save resumable onboarding progress. The flow POSTs the whole typed state on each step (debounced). */
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { saveOnboardingState } from "@/lib/onboarding-store";
import type { OnboardingState } from "@/lib/onboarding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const email = await currentUser();
  if (!email) return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  let state: OnboardingState;
  try { state = (await req.json()) as OnboardingState; } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  if (!state || typeof state.stage !== "number") return NextResponse.json({ error: "bad state" }, { status: 400 });
  await saveOnboardingState(email, state).catch(() => {});
  return NextResponse.json({ ok: true });
}
