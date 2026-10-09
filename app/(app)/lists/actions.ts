"use server";

import { currentUser } from "@/lib/auth";
import { createList, deleteList, type SavedView } from "@/lib/lists";

type Result = { ok: true; id?: string } | { ok: false; error: string };

export async function saveListAction(name: string, view: SavedView, count: number | null): Promise<Result> {
  const email = await currentUser();
  if (!email) return { ok: false, error: "Please sign in again." };
  if (!name.trim()) return { ok: false, error: "Give the list a name." };
  try {
    const id = await createList(email, name, view ?? {}, count);
    return { ok: true, id };
  } catch {
    return { ok: false, error: "Couldn't save the list — please try again." };
  }
}

export async function deleteListAction(id: string): Promise<Result> {
  const email = await currentUser();
  if (!email) return { ok: false, error: "Please sign in again." };
  try {
    await deleteList(email, id);
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't delete — please try again." };
  }
}
