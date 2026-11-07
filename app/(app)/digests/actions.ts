"use server";

import { currentUser } from "@/lib/auth";
import { setDigestPrefs, type LeadCadence } from "@/lib/profile";

type Result = { ok: true } | { ok: false; error: string };

export async function setDigestAction(on: boolean): Promise<Result> {
  const email = await currentUser();
  if (!email) return { ok: false, error: "Please sign in again." };
  try {
    await setDigestPrefs(email, { digest: on });
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't save — please try again." };
  }
}

export async function setCadenceAction(cadence: string): Promise<Result> {
  const email = await currentUser();
  if (!email) return { ok: false, error: "Please sign in again." };
  const c = (["daily", "weekly", "monthly"].includes(cadence) ? cadence : "weekly") as LeadCadence;
  try {
    await setDigestPrefs(email, { cadence: c });
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't save — please try again." };
  }
}
