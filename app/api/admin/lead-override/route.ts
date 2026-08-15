/** Admin: manual lead corrections (overrides). Owner-only.
 *  GET  ?domain=  -> current known values + any existing override
 *  POST { domain, ...fields } -> upsert an override
 *  DELETE ?domain= -> clear the override (revert to source)
 */

import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { db, ensureSchema } from "@/lib/radar/db";
import { getOverride, saveOverride, clearOverride, type Override } from "@/lib/overrides";
import { cleanDomain } from "@/lib/radar/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function guard() {
  return isAdmin(await currentUser());
}

export async function GET(req: Request) {
  if (!(await guard())) return NextResponse.json({ error: "Not authorised" }, { status: 403 });
  const domain = cleanDomain(new URL(req.url).searchParams.get("domain") ?? "");
  if (!domain) return NextResponse.json({ error: "domain required" }, { status: 400 });

  await ensureSchema();
  const [cur] = await db()`
    SELECT domain, name, email, country, currency, plus, theme,
           product_count, price_min, price_max, payments, estimated_monthly_sales
    FROM imported_stores WHERE domain = ${domain} LIMIT 1`;
  const override = await getOverride(domain);
  return NextResponse.json({ domain, current: cur ?? null, override });
}

export async function POST(req: Request) {
  const email = await currentUser();
  if (!isAdmin(email)) return NextResponse.json({ error: "Not authorised" }, { status: 403 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const domain = cleanDomain(String(body.domain ?? ""));
  if (!domain) return NextResponse.json({ error: "domain required" }, { status: 400 });

  // Only pass through known fields; empty string means "clear this field" (null).
  const clean = (v: unknown) => (v === "" || v == null ? null : v);
  const fields: Partial<Override> = {
    name: clean(body.name) as string | null,
    email: clean(body.email) as string | null,
    country: clean(body.country) as string | null,
    currency: clean(body.currency) as string | null,
    plus: body.plus == null ? null : Boolean(body.plus),
    theme: clean(body.theme) as string | null,
    product_count: body.product_count === "" || body.product_count == null ? null : Number(body.product_count),
    price_min: body.price_min === "" || body.price_min == null ? null : Number(body.price_min),
    price_max: body.price_max === "" || body.price_max == null ? null : Number(body.price_max),
    payments: clean(body.payments) as string | null,
    hidden: Boolean(body.hidden),
    note: clean(body.note) as string | null,
  };
  await saveOverride(domain, fields, email!);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  if (!(await guard())) return NextResponse.json({ error: "Not authorised" }, { status: 403 });
  const domain = cleanDomain(new URL(req.url).searchParams.get("domain") ?? "");
  if (!domain) return NextResponse.json({ error: "domain required" }, { status: 400 });
  await clearOverride(domain);
  return NextResponse.json({ ok: true });
}
