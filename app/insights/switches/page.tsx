import { redirect } from "next/navigation";
import { currentUser, isAdmin } from "@/lib/auth";
import { getSubscriber, hasAccess } from "@/lib/subscriptions";
import { paymentShifts } from "@/lib/provider-insights";
import { availableCountries, type PeriodKey } from "@/lib/insights";
import { SwitchesView } from "./switches-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Provider switches" };
const PDAYS: Record<PeriodKey, number> = { day: 1, week: 7, month: 30, quarter: 91, year: 365 };
const PERIODS: PeriodKey[] = ["day", "week", "month", "quarter", "year"];

export default async function SwitchesReport({
  searchParams,
}: {
  searchParams: Promise<{ country?: string; period?: string }>;
}) {
  const email = await currentUser();
  if (!email) redirect("/login");
  const subscriber = await getSubscriber(email).catch(() => null);
  if (!hasAccess(subscriber) && !isAdmin(email)) redirect("/billing");

  const sp = await searchParams;
  const countries = await availableCountries().catch(() => [] as { country: string; stores: number }[]);
  const country = sp.country && countries.some((c) => c.country === sp.country) ? sp.country : "ZA";
  const period = (PERIODS.includes(sp.period as PeriodKey) ? sp.period : "month") as PeriodKey;

  const shifts = await paymentShifts(PDAYS[period], country, 300).catch(() => []);
  return <SwitchesView shifts={shifts} country={country} countries={countries.map((c) => c.country)} period={period} />;
}
