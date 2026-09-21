/** Lightweight JA/EN dictionary for the /jp locale — no i18n framework, just the demo surfaces.
 *  Locale comes from ?lang= or the `jp_lang` cookie; Japanese is the default for the JP scope. */
export type Locale = "ja" | "en";

export const DICT = {
  brand: { ja: "テレイン・ジャパン", en: "Terrain Japan" },
  tagline: {
    ja: "日本のEコマースをCMS・決済・出店時期で可視化する市場インテリジェンス",
    en: "Market intelligence on Japanese e-commerce — by platform, payments and launch date",
  },
  nav_overview: { ja: "概要", en: "Overview" },
  nav_leads: { ja: "店舗リード", en: "Store leads" },
  signout: { ja: "ログアウト", en: "Sign out" },

  stat_stores: { ja: "追跡中の店舗", en: "Tracked stores" },
  stat_dated: { ja: "出店時期あり", en: "With launch date" },
  stat_payments: { ja: "決済データあり", en: "With payment data" },
  stat_newq: { ja: "今四半期の新規", en: "New this quarter" },

  h_platform: { ja: "プラットフォーム別", en: "By platform" },
  h_platform_sub: { ja: "日本の店舗が使うEコマース基盤", en: "The e-commerce platforms Japanese stores run on" },
  h_launches: { ja: "出店時期の推移", en: "Launches over time" },
  h_launches_sub: { ja: "年ごとの新規出店数（出店時期ベース）", en: "New stores per year, by real launch date" },
  h_payments: { ja: "主要な決済プロバイダ", en: "Top payment providers" },
  h_payments_sub: { ja: "チェックアウトで確認した決済手段", en: "Verified at checkout" },

  col_store: { ja: "店舗", en: "Store" },
  col_platform: { ja: "プラットフォーム", en: "Platform" },
  col_launched: { ja: "出店時期", en: "Launched" },
  col_payments: { ja: "決済", en: "Payments" },
  col_location: { ja: "所在地", en: "Location" },
  col_category: { ja: "カテゴリ", en: "Category" },
  col_products: { ja: "商品数", en: "Products" },

  leads_title: { ja: "日本の店舗リード", en: "Japan store leads" },
  leads_sub: {
    ja: "出店時期・プラットフォーム・決済でフィルタ。新しい店舗が上位に表示されます。",
    en: "Newest first — filter by launch date, platform and payments.",
  },
  leads_search: { ja: "店舗・ドメイン・カテゴリで検索", en: "Search store, domain or category" },
  leads_all: { ja: "すべて", en: "All" },
  leads_count: { ja: "件", en: "" },
  none: { ja: "該当なし", en: "None" },
  no_date: { ja: "不明", en: "unknown" },
} as const;

export type DictKey = keyof typeof DICT;
export function t(key: DictKey, locale: Locale): string {
  return DICT[key][locale];
}
