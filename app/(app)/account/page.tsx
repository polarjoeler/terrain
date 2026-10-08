import { currentUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getOrgProfile, orgKey } from "@/lib/profile";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — My profile" };

const prettify = (s: string) =>
  s.replace(/[._-]+/g, " ").trim().split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") || s;

export default async function AccountPage() {
  const email = await currentUser();
  if (!email) redirect("/login");
  const org = await getOrgProfile(orgKey(email)).catch(() => null);
  const workspace = orgKey(email).includes("@") ? prettify(email.split("@")[0]) : prettify(orgKey(email).split(".")[0]);

  const rows: [string, string][] = [
    ["Name", prettify(email.split("@")[0] || "")],
    ["Email", email],
    ["Workspace", workspace],
    ["Plan role", org ? "Owner" : "Member"],
  ];

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="rounded-3xl border border-cream/10 bg-cream/[0.02] p-6">
        <h2 className="font-display text-2xl text-cream">My profile</h2>
        <dl className="mt-5 divide-y divide-cream/10">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-4 py-3">
              <dt className="text-sm text-cream/45">{k}</dt>
              <dd className="truncate text-sm text-cream">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-xs text-cream/35">
          Editing your name, workspace and team seats is part of the account &amp; workspace update coming next.
        </p>
      </div>
    </div>
  );
}
