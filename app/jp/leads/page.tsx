import { jpLeads } from "@/lib/jp";
import { jpLocale } from "../locale";
import { JpLeadsTable } from "./leads-table";

export const dynamic = "force-dynamic";

export default async function JpLeadsPage() {
  const [locale, leads] = await Promise.all([jpLocale(), jpLeads(300)]);
  return <JpLeadsTable leads={leads} locale={locale} />;
}
