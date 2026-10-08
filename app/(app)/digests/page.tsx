import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getUserProfile, getOrgProfile, orgKey } from "@/lib/profile";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Digests" };

export default async function DigestsPage() {
  const email = await currentUser();
  if (!email) redirect("/login");
  const profile = await getUserProfile(email).catch(() => null);
  const org = await getOrgProfile(orgKey(email)).catch(() => null);
  const optedIn = !!profile?.digest;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="rounded-3xl border border-cream/10 bg-cream/[0.02] p-6">
        <h2 className="font-display text-2xl text-cream">Your digests</h2>
        <p className="mt-2 text-sm text-cream/55">
          Recurring briefings — new stores, migrations, payment shifts and market movement — delivered on your schedule.
        </p>

        <div className="mt-5 flex items-center justify-between rounded-2xl border border-cream/10 bg-cream/[0.02] px-4 py-3">
          <div>
            <div className="text-sm font-medium text-cream">Weekly email digest</div>
            <div className="mt-0.5 text-xs text-cream/45">{optedIn ? "You're subscribed." : "Not subscribed yet."}</div>
          </div>
          <span className={`rounded-full px-3 py-1 text-xs font-medium ${optedIn ? "bg-mint/15 text-mint" : "border border-cream/15 text-cream/50"}`}>
            {optedIn ? "On" : "Off"}
          </span>
        </div>

        {!profile && (
          <Link href="/onboarding" className="mt-4 inline-block rounded-full bg-mint px-5 py-2 text-sm font-semibold text-ink transition hover:brightness-105">
            Set up your digest →
          </Link>
        )}
      </div>

      <p className="px-1 text-xs text-cream/35">
        Per-topic digests{org?.companyType ? "" : ""} and channel controls (Slack, WhatsApp) are being built — for now the weekly email covers your markets.
      </p>
    </div>
  );
}
