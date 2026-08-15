/** Run a Brand Audit: fingerprint the brand + scan the market universe, persist,
 *  and return the audit id so the client can open /radar/scan/<id>. */

import { NextResponse } from "next/server";
import { runAudit, saveAudit, type AuditInput } from "@/lib/radar/audit";
import type { Market } from "@/lib/prioritize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // the deep pass fetches candidate catalogues

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string")
    return v.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  return [];
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const brandDomain = str(body.brandDomain);
  if (!brandDomain) {
    return NextResponse.json({ error: "brandDomain is required" }, { status: 400 });
  }

  const input: AuditInput = {
    brandDomain,
    brandName: str(body.brandName) || undefined,
    officialDomains: list(body.officialDomains),
    market: (str(body.market) as Market) || "South Africa",
    suspects: list(body.suspects),
    email: str(body.email) || undefined,
    priorities: list(body.priorities),
    trademark: str(body.trademark) || undefined,
  };

  try {
    const result = await runAudit(input);
    await saveAudit(input, result);
    return NextResponse.json({ id: result.id, error: result.error ?? null });
  } catch (err) {
    console.error("audit failed", err);
    return NextResponse.json({ error: "Scan failed — please try again." }, { status: 500 });
  }
}
