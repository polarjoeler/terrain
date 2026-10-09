import { currentUser } from "@/lib/auth";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Support" };

const SUPPORT_EMAIL = "hello@heyterrain.com";

export default async function SupportPage() {
  if (!(await currentUser())) redirect("/login");
  return (
    <div className="mx-auto max-w-2xl">
      <div className="rounded-3xl border border-cream/10 bg-cream/[0.02] p-8 text-center">
        <h2 className="font-display text-2xl text-cream">Contact support</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-cream/55">
          Questions, data requests, or something not working? We read every message and usually reply within a day.
        </p>
        <a href={`mailto:${SUPPORT_EMAIL}`} className="mt-5 inline-block rounded-full bg-mint px-5 py-2 text-sm font-semibold text-ink transition hover:brightness-105">
          Email {SUPPORT_EMAIL}
        </a>
      </div>
    </div>
  );
}
