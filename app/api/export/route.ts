/** Export selected stores to CSV. Pro-only, 200 rows/month, server-enforced. */

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { currentUser } from "@/lib/auth";
import { publishedLeads } from "@/lib/imported";
import { consumeExportQuota } from "@/lib/subscriptions";
import { sharingGate, logExport, ipOf } from "@/lib/sessions";
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
  { key: "category", label: "Category" },
  { key: "estMonthlySales", label: "Est. monthly sales (USD)" },
  { key: "productsSold", label: "Products sold" },
  { key: "city", label: "City" },
  { key: "plan", label: "Plan" },
  { key: "payments", label: "Payment providers" },
  { key: "technologies", label: "Technologies" },
  { key: "instagram", label: "Instagram" },
  { key: "instagramFollowers", label: "Instagram followers" },
  { key: "facebook", label: "Facebook" },
  { key: "facebookFollowers", label: "Facebook followers" },
  { key: "tiktok", label: "TikTok" },
  { key: "description", label: "Description" },
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

  // Anti-sharing: block bulk export when the seat is signed in from too many devices at once
  // (the classic shared-login signal). Browsing stays open; only exfiltration is gated.
  const gate = await sharingGate(email);
  if (!gate.ok) {
    return NextResponse.json(
      { error: `This account is signed in from ${gate.ips} locations (limit ${gate.cap}). Sign out other devices, or contact us to add seats.`, sharing: true },
      { status: 403 },
    );
  }

  // Reserve quota BEFORE doing work (server-enforced, can't be bypassed).
  const quota = await consumeExportQuota(email, wanted.size);
  if (!quota.ok) {
    return NextResponse.json(
      { error: quota.reason, remaining: quota.remaining, limit: quota.limit },
      { status: 403 },
    );
  }

  const leads = await publishedLeads();
  const selected = leads.filter((l) => wanted.has(l.domain));

  const header = COLUMNS.map((c) => c.label).join(",");
  const lines = selected.map((l) =>
    COLUMNS.map((c) => csvCell(l[c.key])).join(","),
  );
  // Watermark: every export is stamped + logged, so a redistributed CSV is traceable to the seat.
  const exportId = randomUUID().slice(0, 8);
  const ts = new Date().toISOString();
  const watermark = `# Terrain export — licensed to ${email} · ${ts} · id ${exportId} · redistribution is traceable`;
  const csv = [header, ...lines, "", watermark].join("\n");   // footer, so imports read the header as row 1
  await logExport(email, exportId, selected.length, ipOf(req));

  const stamp = ts.slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="terrain-leads-${stamp}.csv"`,
      "X-Export-Remaining": String(quota.remaining),
    },
  });
}
