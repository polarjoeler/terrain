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
           product_count, price_min, price_max, payments, category,
           estimated_monthly_sales, products_sold, city, plan, description,
           technologies, instagram, facebook, tiktok, instagram_followers,
           facebook_followers, first_product_at, first_seen, discovered_at
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
  const numOr = (v: unknown) => (v === "" || v == null ? null : Number(v));
  const fields: Partial<Override> = {
    name: clean(body.name) as string | null,
    email: clean(body.email) as string | null,
    country: clean(body.country) as string | null,
    currency: clean(body.currency) as string | null,
    plus: body.plus == null ? null : Boolean(body.plus),
    theme: clean(body.theme) as string | null,
    product_count: numOr(body.product_count),
    price_min: numOr(body.price_min),
    price_max: numOr(body.price_max),
    payments: clean(body.payments) as string | null,
    category: clean(body.category) as string | null,
    estimated_monthly_sales: numOr(body.estimated_monthly_sales),
    products_sold: numOr(body.products_sold),
    city: clean(body.city) as string | null,
    plan: clean(body.plan) as string | null,
    description: clean(body.description) as string | null,
    technologies: clean(body.technologies) as string | null,
    instagram: clean(body.instagram) as string | null,
    facebook: clean(body.facebook) as string | null,
    tiktok: clean(body.tiktok) as string | null,
    instagram_followers: numOr(body.instagram_followers),
    facebook_followers: numOr(body.facebook_followers),
    first_product_at: clean(body.first_product_at) as string | null,
    first_seen: clean(body.first_seen) as string | null,
    discovered_at: clean(body.discovered_at) as string | null,
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
