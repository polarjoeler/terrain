import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { saveOnboarding, type OnboardingInput, type CompanyType, type LeadCadence, type Ingestion } from "@/lib/profile";

const COMPANY: CompanyType[] = ["payments", "app_developer", "investor", "researcher", "shipping", "agency", "other"];
const CADENCE: LeadCadence[] = ["daily", "weekly", "monthly"];
const INGEST: Ingestion[] = ["crm", "csv", "api", "in_app"];
const asArr = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 12) : []);

export async function POST(req: Request) {
  const email = await currentUser();
  if (!email) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const b = await req.json().catch(() => null);
  if (!b) return NextResponse.json({ error: "bad body" }, { status: 400 });

  const leadCadence = CADENCE.includes(b.leadCadence) ? b.leadCadence : "weekly";
  const ingestion = INGEST.includes(b.ingestion) ? b.ingestion : "csv";
  const input: OnboardingInput = {
    companyType: COMPANY.includes(b.companyType) ? b.companyType : undefined,
    cmsFocus: asArr(b.cmsFocus),
    trackOwnPerformance: !!b.trackOwnPerformance,
    extras: typeof b.extras === "string" ? b.extras.slice(0, 2000) : undefined,
    leadCadence, leadFocus: asArr(b.leadFocus), ingestion, digest: b.digest !== false,
  };
  try {
    await saveOnboarding(email, input);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
