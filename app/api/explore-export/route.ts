/** Explorer "Export → CSV": the FULL filtered set, server-side.
 *
 *  The leads Explorer is server-paginated (lib/browse.ts) — the browser only ever holds one ~60-row
 *  page, so it can't build the export client-side any more (and the old client export was unmetered
 *  and only ever covered the loaded rows). This endpoint takes the SAME BrowseFilters the Explorer is
 *  showing and re-queries every matching row with the full field set. Ticked rows arrive as
 *  { domains: [...] }, which buildWhere treats as just another filter.
 *
 *  Access, anti-sharing, the plan's platform ceiling and the monthly row quota all come from
 *  lib/export-gate.ts, shared with the Google Sheets export so there is one gate, not two. */
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { browseExportRows, toCsv, type BrowseFilters } from "@/lib/browse";
import { openExport, scopeFilters, chargeExport } from "@/lib/export-gate";
import { logExport, ipOf } from "@/lib/sessions";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const open = await openExport();
  if (!open.ok) return open.response;

  let filters: BrowseFilters;
  try {
    filters = (await req.json()) as BrowseFilters;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const { header, rows } = await browseExportRows(scopeFilters(filters, open.scope));
  if (rows.length === 0) {
    return NextResponse.json({ error: "Nothing to export — no stores match those filters on your plan.", empty: true }, { status: 400 });
  }

  // Charge the ACTUAL row count, after the query, so nobody pays for rows the filter
  // (or their plan's platform ceiling) didn't return.
  const charge = await chargeExport(open.email, open.admin, rows.length);
  if (!charge.ok) return charge.response;

  // Watermark + log: every export is stamped and traceable to the seat.
  const exportId = randomUUID().slice(0, 8);
  const ts = new Date().toISOString();
  const watermark = `# Terrain export — licensed to ${open.email} · ${ts} · id ${exportId} · redistribution is traceable`;
  const csv = [toCsv(header, rows), "", watermark].join("\n");   // footer, so imports read the header as row 1
  await logExport(open.email, exportId, rows.length, ipOf(req)).catch(() => {});

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="terrain-leads-${ts.slice(0, 10)}.csv"`,
      "X-Export-Rows": String(rows.length),
      "X-Export-Remaining": charge.remaining == null ? "unmetered" : String(charge.remaining),
    },
  });
}
