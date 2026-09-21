import { cookies } from "next/headers";
import type { Locale } from "@/lib/jp-i18n";

/** JP-scope locale from the `jp_lang` cookie — Japanese by default. Server-only. */
export async function jpLocale(): Promise<Locale> {
  return (await cookies()).get("jp_lang")?.value === "en" ? "en" : "ja";
}
