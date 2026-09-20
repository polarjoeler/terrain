import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { orgHasProfile, orgKey } from "@/lib/profile";
import { OnboardingForm } from "./onboarding-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Set up your workspace" };

export default async function OnboardingPage() {
  const email = await currentUser();
  if (!email) redirect("/login");

  // First user of a company (domain) gets the full company profiler; later teammates get the
  // short one (just their digest + lead prefs) — the company answers are inherited.
  const hasOrg = await orgHasProfile(email).catch(() => false);
  const firstUser = !hasOrg;
  const org = orgKey(email);
  const isCompany = org.includes("@") === false; // domain-keyed = a company inbox

  return (
    <main className="min-h-screen px-4 py-10">
      <div className="mx-auto max-w-xl">
        <h1 className="font-display text-3xl text-cream">Set up your workspace</h1>
        <p className="mt-2 text-sm text-cream/50">
          {firstUser
            ? "A few questions so Terrain shows you the right data and sends leads the way you work."
            : `Welcome to ${isCompany ? org : "the team"} on Terrain — just tell us how you want your leads and digest.`}
        </p>
        <OnboardingForm firstUser={firstUser} />
      </div>
    </main>
  );
}
