import { redirect } from "next/navigation";
import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { t } from "@/lib/jp-i18n";
import { LocaleToggle } from "./locale-toggle";
import { jpLocale } from "./locale";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain Japan · テレイン・ジャパン" };

export default async function JpLayout({ children }: { children: React.ReactNode }) {
  const email = await currentUser();
  if (!email) redirect("/login");
  const locale = await jpLocale();
  return (
    <div className="min-h-screen" style={{ fontFeatureSettings: '"palt" 1' }}>
      <header className="border-b border-cream/10">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-5 py-4">
          <div className="flex items-baseline gap-3">
            <Link href="/jp" className="font-display text-lg text-cream">{t("brand", locale)}</Link>
            <span className="hidden text-[11px] text-cream/40 sm:inline">{t("tagline", locale)}</span>
          </div>
          <nav className="flex items-center gap-2 text-sm">
            <Link href="/jp" className="rounded-full px-3 py-1 text-cream/70 hover:text-cream">{t("nav_overview", locale)}</Link>
            <Link href="/jp/leads" className="rounded-full px-3 py-1 text-cream/70 hover:text-cream">{t("nav_leads", locale)}</Link>
            <LocaleToggle locale={locale} />
          </nav>
        </div>
      </header>
      {children}
    </div>
  );
}
