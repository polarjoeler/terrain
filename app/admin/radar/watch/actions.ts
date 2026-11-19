"use server";

/** Review a Radar Watch candidate. Admin-only. Confirming a clone also takes it out of the lead
 *  list (published = false), because a clone sold as a lead is worse than no lead. Reopening puts
 *  it back only if this action was what unpublished it. Every change writes a store_edits row. */
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { currentUser, isAdmin } from "@/lib/auth";

const STATUSES = new Set(["new", "confirmed", "benign", "dismissed"]);

export async function reviewCandidate(form: FormData): Promise<void> {
  const email = await currentUser();
  if (!email || !isAdmin(email)) throw new Error("unauthorized");
  const suspect = String(form.get("suspect") ?? "");
  const brand = String(form.get("brand") ?? "");
  const status = String(form.get("status") ?? "");
  if (!suspect || !brand || !STATUSES.has(status)) throw new Error("bad request");

  await db().begin(async (q) => {
    const [c] = await q<{ status: string; unpublished_lead: boolean }[]>`
      SELECT status, unpublished_lead FROM lookalike_candidates WHERE suspect = ${suspect} AND brand = ${brand} FOR UPDATE`;
    if (!c) throw new Error("not found");
    const [s] = await q<{ published: boolean | null }[]>`SELECT published FROM imported_stores WHERE domain = ${suspect}`;

    let unpublished = c.unpublished_lead;
    if (status === "confirmed" && s?.published) {
      await q`UPDATE imported_stores SET published = false WHERE domain = ${suspect}`;
      await q`INSERT INTO store_edits (domain, editor, field, old_value, new_value)
        VALUES (${suspect}, ${email}, 'published', 'true', ${`false (Radar Watch: clone of ${brand})`})`;
      unpublished = true;
    } else if (status !== "confirmed" && c.unpublished_lead && s && !s.published) {
      await q`UPDATE imported_stores SET published = true WHERE domain = ${suspect}`;
      await q`INSERT INTO store_edits (domain, editor, field, old_value, new_value)
        VALUES (${suspect}, ${email}, 'published', 'false', ${`true (Radar Watch: reopened as ${status})`})`;
      unpublished = false;
    }
    await q`UPDATE lookalike_candidates SET status = ${status}, reviewed_at = now(), reviewed_by = ${email},
        unpublished_lead = ${unpublished} WHERE suspect = ${suspect} AND brand = ${brand}`;
  });
  revalidatePath("/admin/radar/watch");
}
