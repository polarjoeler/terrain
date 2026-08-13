import { NextResponse } from "next/server";
import { endSession } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  await endSession();
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? new URL(req.url).origin;
  return NextResponse.redirect(`${origin}/`, { status: 303 });
}
