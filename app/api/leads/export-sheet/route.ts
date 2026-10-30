/** Export the current filtered leads to a Google Sheet.
 *
 *  Same data + the SAME gate as the CSV export — both call lib/export-gate.ts, so a plan's
 *  platform ceiling and monthly row quota apply here too. They have to: this is a second door
 *  onto the identical rows, and metering only the CSV one would just move the hole.
 *
 *  Writes to a sheet the user has
 *  shared with Terrain's service account (so it lands live in their Drive, not a download). The user
 *  shares any sheet with SERVICE_ACCOUNT_EMAIL as Editor once, then passes its URL/ID here.
 *
 *  POST { filters: BrowseFilters, sheet: string(url-or-id), tab?: string } → { ok, url, rows } */
import { NextResponse } from "next/server";
import { browseExportRows, type BrowseFilters } from "@/lib/browse";
import { writeLeadSheet, checkSheetAccess, SERVICE_ACCOUNT_EMAIL } from "@/lib/sheets";
import { openExport, scopeFilters, chargeExport } from "@/lib/export-gate";
import { logExport, ipOf } from "@/lib/sessions";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";
export const maxDuration = 120;

const sheetId = (s: string) => (s.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/)?.[1]) ?? s.trim();

export async function POST(req: Request) {
  const open = await openExport();
  if (!open.ok) return open.response;
  const email = open.email;

  let body: { filters?: BrowseFilters; sheet?: string; tab?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const id = sheetId(body.sheet ?? "");
  if (!id) return NextResponse.json({ error: "A Google Sheet URL or ID is required." }, { status: 400 });

  // confirm we can reach it — the commonest failure is "didn't share it with the service account"
  try { await checkSheetAccess(id); }
  catch { return NextResponse.json({ error: `Can't open that sheet. Share it with ${SERVICE_ACCOUNT_EMAIL} (Editor), then try again.`, serviceAccount: SERVICE_ACCOUNT_EMAIL }, { status: 400 }); }

  const { header, rows } = await browseExportRows(scopeFilters(body.filters ?? {}, open.scope));
  if (rows.length === 0) {
    return NextResponse.json({ error: "Nothing to export — no stores match those filters on your plan.", empty: true }, { status: 400 });
  }
  // Charge before writing: a half-written sheet the customer wasn't billed for is worse than
  // a refusal, and the row count is already known here.
  const charge = await chargeExport(email, open.admin, rows.length);
  if (!charge.ok) return charge.response;
  const tab = (body.tab || "Terrain leads").slice(0, 90);
  try {
    const out = await writeLeadSheet(id, tab, header, rows);
    const exportId = randomUUID().slice(0, 8);
    await logExport(email, exportId, out.rows, ipOf(req)).catch(() => {});
    return NextResponse.json({ ok: true, ...out, tab, remaining: charge.remaining, limit: charge.limit });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Export failed" }, { status: 400 });
  }
}
