/** Explorer "Export → CSV": the FULL filtered set, server-side.
 *
 *  The leads Explorer is server-paginated (lib/browse.ts) — the browser only ever holds one ~60-row
 *  page, so it can't build the export client-side any more (and the old client export was unmetered
 *  and only ever covered the loaded rows). This endpoint takes the SAME BrowseFilters the Explorer is
 *  showing and re-queries every matching row with the full field set.
 *
 *  Gated exactly like the browse() action (paid subscriber or owner). Per-seat export QUOTA metering
 *  (consumeExportQuota) lands with the pricing/access workstream; for now the anti-sharing gate +
 *  watermark + export log give traceability without a hard cap. */
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { browseExportCsv, type BrowseFilters } from "@/lib/browse";
import { currentUser, isAdmin } from "@/lib/auth";
import { getSubscriber, hasAccess } from "@/lib/subscriptions";
import { sharingGate, logExport, ipOf } from "@/lib/sessions";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const email = await currentUser();
  if (!email) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const admin = isAdmin(email);
  if (!admin) {
    const sub = await getSubscriber(email).catch(() => null);
    if (!hasAccess(sub)) return NextResponse.json({ error: "no_access" }, { status: 403 });
  }

  // Anti-sharing: block bulk export when the seat is signed in from too many devices at once.
  const gate = await sharingGate(email);
  if (!gate.ok) {
    return NextResponse.json(
      { error: `This account is signed in from ${gate.ips} locations (limit ${gate.cap}). Sign out other devices, or contact us to add seats.`, sharing: true },
      { status: 403 },
    );
  }

  let filters: BrowseFilters;
  try {
    filters = (await req.json()) as BrowseFilters;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const body = await browseExportCsv(filters);
  const rowCount = Math.max(0, body.split("\n").length - 1); // minus header

  // Watermark + log: every export is stamped and traceable to the seat.
  const exportId = randomUUID().slice(0, 8);
  const ts = new Date().toISOString();
  const watermark = `# Terrain export — licensed to ${email} · ${ts} · id ${exportId} · redistribution is traceable`;
  const csv = [body, "", watermark].join("\n");
  await logExport(email, exportId, rowCount, ipOf(req)).catch(() => {});

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="terrain-leads-${ts.slice(0, 10)}.csv"`,
    },
  });
}
