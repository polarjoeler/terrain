/** Export selected stores to CSV. Pro-only, 200 rows/month, server-enforced. */

import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { fetchLeads } from "@/lib/sheets";
import { consumeExportQuota } from "@/lib/subscriptions";
import type { Lead } from "@/lib/leads";

export const runtime = "nodejs";

const COLUMNS: { key: keyof Lead; label: string }[] = [
  { key: "name", label: "Store" },
  { key: "domain", label: "Domain" },
  { key: "country", label: "Country" },
  { key: "productCount", label: "Products" },
  { key: "priceMin", label: "Price min" },
  { key: "priceMax", label: "Price max" },
  { key: "currency", label: "Currency" },
  { key: "email", label: "Email" },
  { key: "theme", label: "Theme" },
  { key: "plus", label: "Shopify Plus" },
  { key: "firstProductAt", label: "First product" },
  { key: "firstSeen", label: "First seen" },
];

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = Array.isArray(v) ? v.join("; ") : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function POST(req: Request) {
  const email = await currentUser();
  if (!email) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let body: { domains?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const wanted = new Set((body.domains ?? []).filter(Boolean));
  if (wanted.size === 0) {
    return NextResponse.json({ error: "No stores selected" }, { status: 400 });
  }

  // Reserve quota BEFORE doing work (server-enforced, can't be bypassed).
  const quota = await consumeExportQuota(email, wanted.size);
  if (!quota.ok) {
    return NextResponse.json(
      { error: quota.reason, remaining: quota.remaining, limit: quota.limit },
      { status: 403 },
    );
  }

  const { leads } = await fetchLeads();
  const selected = leads.filter((l) => wanted.has(l.domain));

  const header = COLUMNS.map((c) => c.label).join(",");
  const lines = selected.map((l) =>
    COLUMNS.map((c) => csvCell(l[c.key])).join(","),
  );
  const csv = [header, ...lines].join("\n");

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="terrain-leads-${stamp}.csv"`,
      "X-Export-Remaining": String(quota.remaining),
    },
  });
}
