"use client";
import { useRouter } from "next/navigation";
import type { Locale } from "@/lib/jp-i18n";

export function LocaleToggle({ locale }: { locale: Locale }) {
  const router = useRouter();
  const set = (l: Locale) => {
    document.cookie = `jp_lang=${l};path=/;max-age=31536000;samesite=lax`;
    router.refresh();
  };
  return (
    <div className="inline-flex overflow-hidden rounded-full border border-cream/20 text-xs font-semibold">
      {(["ja", "en"] as const).map((l) => (
        <button key={l} onClick={() => set(l)}
          className={`px-3 py-1 transition ${locale === l ? "bg-cream text-ink" : "text-cream/60 hover:text-cream"}`}>
          {l === "ja" ? "日本語" : "EN"}
        </button>
      ))}
    </div>
  );
}
