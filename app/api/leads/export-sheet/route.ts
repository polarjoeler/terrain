/** Export the current filtered leads to a Google Sheet.
 *
 *  Same data + gating as the CSV export (/api/explore-export), but writes to a sheet the user has
 *  shared with Terrain's service account (so it lands live in their Drive, not a download). The user
 *  shares any sheet with SERVICE_ACCOUNT_EMAIL as Editor once, then passes its URL/ID here.
 *
 *  POST { filters: BrowseFilters, sheet: string(url-or-id), tab?: string } → { ok, url, rows } */
import { NextResponse } from "next/server";
import { browseExportRows, type BrowseFilters } from "@/lib/browse";
import { writeLeadSheet, checkSheetAccess, SERVICE_ACCOUNT_EMAIL } from "@/lib/sheets";
import { currentUser, isAdmin } from "@/lib/auth";
import { getSubscriber, hasAccess } from "@/lib/subscriptions";
import { sharingGate, logExport, ipOf } from "@/lib/sessions";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";
export const maxDuration = 120;

const sheetId = (s: string) => (s.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/)?.[1]) ?? s.trim();

export async function POST(req: Request) {
  const email = await currentUser();
  if (!email) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  if (!isAdmin(email)) {
    const sub = await getSubscriber(email).catch(() => null);
    if (!hasAccess(sub)) return NextResponse.json({ error: "no_access" }, { status: 403 });
  }
  const gate = await sharingGate(email);
  if (!gate.ok) return NextResponse.json({ error: `Signed in from ${gate.ips} locations (limit ${gate.cap}). Sign out other devices or add seats.`, sharing: true }, { status: 403 });

  let body: { filters?: BrowseFilters; sheet?: string; tab?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const id = sheetId(body.sheet ?? "");
  if (!id) return NextResponse.json({ error: "A Google Sheet URL or ID is required." }, { status: 400 });

  // confirm we can reach it — the commonest failure is "didn't share it with the service account"
  try { await checkSheetAccess(id); }
  catch { return NextResponse.json({ error: `Can't open that sheet. Share it with ${SERVICE_ACCOUNT_EMAIL} (Editor), then try again.`, serviceAccount: SERVICE_ACCOUNT_EMAIL }, { status: 400 }); }

  const { header, rows } = await browseExportRows(body.filters ?? {});
  const tab = (body.tab || "Terrain leads").slice(0, 90);
  try {
    const out = await writeLeadSheet(id, tab, header, rows);
    const exportId = randomUUID().slice(0, 8);
    await logExport(email, exportId, out.rows, ipOf(req)).catch(() => {});
    return NextResponse.json({ ok: true, ...out, tab });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Export failed" }, { status: 400 });
  }
}
