import { currentUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { listLists } from "@/lib/lists";
import { marketLabel } from "@/lib/markets";
import { platformLabel } from "@/lib/platforms";
import type { ExploreInitial } from "@/app/admin/explore/explorer";
import { ListsView } from "./lists-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Saved lists" };

// A short human summary of a saved filter view, for the card.
function summarize(view: ExploreInitial): string {
  const v = view;
  const parts: string[] = [];
  if (v.platform?.length) parts.push(v.platform.map(platformLabel).join(", "));
  if (v.country?.length) parts.push(v.country.map((c) => marketLabel(c).replace(/^[^\p{L}]+/u, "")).join(", "));
  if (v.category?.length) parts.push(v.category.slice(0, 2).join(", ") + (v.category.length > 2 ? "…" : ""));
  if (v.band?.length) parts.push(v.band.join(", "));
  if (v.payment?.length) parts.push("pays " + v.payment.slice(0, 2).join(", "));
  if (v.activity?.length) parts.push(v.activity.join(", "));
  if (v.launched) parts.push("launched " + v.launched);
  if (v.recency) parts.push("new " + v.recency);
  if (v.plus) parts.push("Shopify Plus");
  if (v.email) parts.push("has email");
  if (v.noPayment) parts.push("no gateway yet");
  if (v.tier) parts.push(v.tier === "top100" ? "Top 100" : "Top 500");
  if (v.q) parts.push(`“${v.q}”`);
  return parts.length ? parts.join(" · ") : "All stores · no filters";
}

export default async function ListsPage() {
  const email = await currentUser();
  if (!email) redirect("/login");

  const rows = await listLists(email).catch(() => []);
  const lists = rows.map((l) => ({ id: l.id, name: l.name, count: l.count, createdAt: l.createdAt, summary: summarize(l.view as ExploreInitial) }));

  return <ListsView lists={lists} />;
}
