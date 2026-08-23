/** Admin: extract an import-ready CSV from a screenshot of a store table (Claude
 *  vision). Returns the CSV for review — does NOT import. The admin edits it and
 *  posts to /api/admin/import to commit. Owner-only. */

import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { extractStoresCsv, type VisionMediaType } from "@/lib/vision-import";

export const runtime = "nodejs";
export const maxDuration = 300; // PDFs (many pages) can take longer than a single image

const ALLOWED: VisionMediaType[] = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"];

export async function POST(req: Request) {
  if (!isAdmin(await currentUser())) {
    return NextResponse.json({ error: "Not authorised" }, { status: 403 });
  }
  let body: { image?: string; mediaType?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const image = (body.image ?? "").replace(/^data:[^,]+,/, ""); // tolerate a data: URL
  const mediaType = body.mediaType as VisionMediaType;
  if (!image) return NextResponse.json({ error: "No file" }, { status: 400 });
  if (!ALLOWED.includes(mediaType)) {
    return NextResponse.json({ error: "Unsupported file type (use PNG/JPEG/GIF/WebP or PDF)" }, { status: 400 });
  }
  // PDFs carry many pages, so allow a larger payload; ~45MB base64 ≈ 32MB PDF
  // (Anthropic's document limit). Images stay at ~5MB.
  const limit = mediaType === "application/pdf" ? 45_000_000 : 7_500_000;
  if (image.length > limit) {
    return NextResponse.json(
      { error: mediaType === "application/pdf" ? "PDF too large (max ~32MB)" : "Image too large (max ~5MB)" },
      { status: 400 },
    );
  }
  try {
    const csv = await extractStoresCsv(image, mediaType);
    const rows = Math.max(0, csv.trim().split("\n").length - 1);
    return NextResponse.json({ ok: true, csv, rows });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Extraction failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
