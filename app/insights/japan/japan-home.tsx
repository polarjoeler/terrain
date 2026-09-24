"use client";

import { useState } from "react";
import Link from "next/link";
import { Wordmark } from "@/app/components/logo";
import type { JapanTimeline } from "@/lib/japan-timeline";
import { JapanReplay, type Lang } from "./japan-replay";

/* The full Japan homepage — parity with the Africa homepage (app/page.tsx) but Japan-tuned and
   bilingual. A single JP/EN toggle in the nav drives every string here AND the map (JapanReplay
   takes a controlled `lang` prop). All copy lives in COPY so switching language is one state flip;
   text is rendered through {expressions} (JS strings), which sidesteps JSX unescaped-entity rules. */

const toneCls: Record<string, string> = { cyan: "border-cyan/25 text-cyan", mint: "border-mint/25 text-mint", lilac: "border-lilac/25 text-lilac" };
const toneBg: Record<string, string> = { cyan: "rgba(76,201,212,.14)", mint: "rgba(205,234,169,.16)", lilac: "rgba(202,189,245,.18)" };
const toneFg: Record<string, string> = { cyan: "var(--color-cyan)", mint: "var(--color-mint)", lilac: "var(--color-lilac)" };

const PRODUCTS = [
  { key: "Radar", glyph: "◎", tone: "cyan", href: "/radar" },
  { key: "Switchboard", glyph: "⇄", tone: "mint", href: "/insights/switches" },
  { key: "Shelf", glyph: "▤", tone: "lilac", href: "/insights" },
] as const;

type Copy = {
  nav: { map: string; products: string; who: string; join: string; global: string };
  heroEyebrow: string; heroH1a: string; heroH1b: string; heroSub: string;
  mapWarming: string;
  prodEyebrow: string; prodH2: string; prodSub: string;
  products: Record<string, { audience: string; line: string; explore: string }>;
  whoEyebrow: string; whoH2: string;
  segments: [string, string, string][];
  nlEyebrow: string; nlH2: string; nlSub: string; nlPlaceholder: string; nlButton: string; nlDone: string; nlMock: string;
  footer: string;
};

const COPY: Record<Lang, Copy> = {
  en: {
    nav: { map: "The map", products: "Products", who: "Who it's for", join: "Join the list", global: "🌍 Global" },
    heroEyebrow: "Market intelligence for Japanese commerce",
    heroH1a: "See Japanese eCommerce ", heroH1b: "come to life.",
    heroSub: "Every online store in Japan, appearing on the map by its launch date — a decade of growth in thirty seconds. Terrain tracks it so you don't have to.",
    mapWarming: "Map warming up…",
    prodEyebrow: "One spine, three lenses",
    prodH2: "The same market, seen the way you need it.",
    prodSub: "Every store, what it sells, what it's built with, who it pays — read as brand protection, distribution, or the fight for the rails.",
    products: {
      Radar: { audience: "For brands", explore: "Explore Radar →", line: "Clone & brand-abuse detection. Radar fingerprints your catalogue — images, SKUs, prices — and finds every store copying it, then keeps watching for new ones." },
      Switchboard: { audience: "For payment, shipping & app vendors", explore: "Explore Switchboard →", line: "Win/loss and share-of-market on the rails. See who's switching payment, shipping and app providers — where, when, and to whom — across the market." },
      Shelf: { audience: "For brands", explore: "Explore Shelf →", line: "Distribution monitoring. Track where your product — and your competitors' — sits on the shelf across every storefront that carries it." },
    },
    whoEyebrow: "Who it's for",
    whoH2: "Built for the people who move the market.",
    segments: [
      ["🔬", "Researchers", "Clean, structured market data to cite and build on."],
      ["🧭", "Freelancers & Consultants", "Win pitches with the whole landscape in one view."],
      ["🏢", "Agencies", "Find prospects and prove the market to clients."],
      ["📈", "Investors", "Size markets and spot momentum before it's obvious."],
      ["💳", "Payment Providers", "See who's live, on what rails, and who to win."],
      ["🧩", "App Builders", "Reach the right merchants with the right integrations."],
      ["📦", "Shipping Providers", "Map demand and route into growing store clusters."],
      ["🛍️", "Online Stores", "Benchmark against the market and find your edge."],
    ],
    nlEyebrow: "Coming soon",
    nlH2: "Get the Japanese commerce briefing.",
    nlSub: "New stores, provider switches, and market moves across Japan's eight regions — a short weekly read.",
    nlPlaceholder: "you@company.com", nlButton: "Join",
    nlDone: "Thanks — you're on the early list ✦",
    nlMock: "Mock-up — the form isn't connected to a mailing list yet.",
    footer: "Japan · a Tembo Commerce product",
  },
  ja: {
    nav: { map: "地図", products: "製品", who: "対象ユーザー", join: "リストに登録", global: "🌍 グローバル" },
    heroEyebrow: "日本のコマースのためのマーケットインテリジェンス",
    heroH1a: "日本のeコマースが、", heroH1b: "動き出す。",
    heroSub: "日本のあらゆるオンラインストアを、開設時期に沿って地図上に表示。10年間の成長を30秒で。あとは Terrain が追跡します。",
    mapWarming: "地図を準備中…",
    prodEyebrow: "ひとつの基盤、三つの視点",
    prodH2: "同じ市場を、必要な形で。",
    prodSub: "すべてのストアの取扱商品・構築技術・決済手段を、ブランド保護・流通・決済インフラ争いの観点から読み解きます。",
    products: {
      Radar: { audience: "ブランド向け", explore: "Radar を見る →", line: "模倣店・ブランド不正の検知。Radar は貴社のカタログ（画像・SKU・価格）をフィンガープリント化し、模倣するすべてのストアを検出。新たな模倣も監視し続けます。" },
      Switchboard: { audience: "決済・配送・アプリ事業者向け", explore: "Switchboard を見る →", line: "決済インフラの勝敗とシェア。決済・配送・アプリの各プロバイダーを、誰が・どこで・いつ・どこへ乗り換えているかを市場全体で可視化します。" },
      Shelf: { audience: "ブランド向け", explore: "Shelf を見る →", line: "流通モニタリング。自社製品と競合製品が、取り扱う各店舗の「棚」のどこにあるかを追跡します。" },
    },
    whoEyebrow: "対象ユーザー",
    whoH2: "市場を動かす人のために。",
    segments: [
      ["🔬", "研究者", "引用・分析に使える、整ったマーケットデータ。"],
      ["🧭", "フリーランス・コンサルタント", "市場全体を一望し、提案で勝つ。"],
      ["🏢", "代理店", "見込み客を見つけ、市場をクライアントに示す。"],
      ["📈", "投資家", "市場規模を測り、動きを先取りする。"],
      ["💳", "決済プロバイダー", "誰が稼働し、どの手段を使い、誰を獲得すべきか。"],
      ["🧩", "アプリ開発者", "最適な統合を、最適な店舗へ届ける。"],
      ["📦", "配送プロバイダー", "需要を地図化し、成長する店舗群へ。"],
      ["🛍️", "オンラインストア", "市場と比較し、自社の強みを見つける。"],
    ],
    nlEyebrow: "近日公開",
    nlH2: "日本コマースのブリーフィングを受け取る。",
    nlSub: "新規ストア、プロバイダーの乗り換え、8地域の市場動向を、毎週手短に。",
    nlPlaceholder: "you@company.com", nlButton: "登録",
    nlDone: "ありがとうございます — 先行リストに登録されました ✦",
    nlMock: "モックアップ — フォームはまだメーリングリストに接続されていません。",
    footer: "日本 · Tembo Commerce プロダクト",
  },
};

export function JapanHome({ data, initialLang = "en" }: { data: JapanTimeline; initialLang?: Lang }) {
  const [lang, setLang] = useState<Lang>(initialLang);
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const L = COPY[lang];
  const ready = data.months.length > 0;

  return (
    <main className="pt-4">
      {/* nav */}
      <div className="px-4">
        <nav className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 rounded-full border border-cream/12 bg-cream/[0.06] py-2 pl-5 pr-2 backdrop-blur">
          <Link href="/japan" className="text-cream"><Wordmark /></Link>
          <div className="hidden items-center gap-7 text-sm text-cream/60 md:flex">
            <a href="#map" className="hover:text-cream">{L.nav.map}</a>
            <a href="#products" className="hover:text-cream">{L.nav.products}</a>
            <a href="#who" className="hover:text-cream">{L.nav.who}</a>
            <Link href="/?geo=off" className="hover:text-cream">{L.nav.global}</Link>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex overflow-hidden rounded-full border border-cream/15 text-xs font-semibold">
              {(["en", "ja"] as const).map((l) => (
                <button key={l} onClick={() => setLang(l)} className={`px-2.5 py-1 transition ${lang === l ? "bg-cream text-ink" : "text-cream/55 hover:text-cream"}`}>{l === "en" ? "EN" : "日本語"}</button>
              ))}
            </div>
            <a href="#join" className="shrink-0 whitespace-nowrap rounded-full bg-cyan px-5 py-2.5 text-sm font-medium text-cyan-deep transition hover:brightness-110">{L.nav.join}</a>
          </div>
        </nav>
      </div>

      {/* hero */}
      <header className="mx-auto max-w-6xl px-6 pb-2 pt-14">
        <span className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan">{L.heroEyebrow}</span>
        <h1 className="mt-4 max-w-3xl font-display text-5xl leading-[1.02] tracking-tight md:text-7xl">
          {L.heroH1a}<em className="text-cyan">{L.heroH1b}</em>
        </h1>
        <p className="mt-5 max-w-2xl text-lg text-cream/60">{L.heroSub}</p>
      </header>

      {/* the live map */}
      <section id="map" className="px-4 py-8">
        <div className="mx-auto max-w-6xl">
          {ready ? <JapanReplay data={data} lang={lang} /> : <p className="rounded-[2rem] border border-cream/12 bg-cream/[0.02] p-8 text-sm text-cream/40">{L.mapWarming}</p>}
        </div>
      </section>

      {/* products */}
      <section id="products" className="px-4 py-20">
        <div className="mx-auto max-w-6xl">
          <span className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan">{L.prodEyebrow}</span>
          <h2 className="mt-3 max-w-2xl font-display text-4xl tracking-tight md:text-5xl">{L.prodH2}</h2>
          <p className="mt-3 max-w-xl text-cream/55">{L.prodSub}</p>
          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {PRODUCTS.map((p) => {
              const c = L.products[p.key];
              return (
                <Link key={p.key} href={p.href} className={`group rounded-[1.75rem] border ${toneCls[p.tone]} bg-cream/[0.02] p-7 transition hover:bg-cream/[0.04]`}>
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl font-display text-2xl" style={{ background: toneBg[p.tone], color: toneFg[p.tone] }}>{p.glyph}</div>
                  <div className="mt-5 flex items-baseline justify-between gap-2">
                    <h3 className="font-display text-3xl text-cream">{p.key}</h3>
                    <span className="text-[11px] uppercase tracking-wide text-cream/40">{c.audience}</span>
                  </div>
                  <p className="mt-3 text-sm leading-relaxed text-cream/60">{c.line}</p>
                  <span className="mt-4 inline-block text-sm text-cream/50 transition group-hover:text-cream">{c.explore}</span>
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      {/* who it's for */}
      <section id="who" className="px-4 py-8 pb-20">
        <div className="mx-auto max-w-6xl">
          <span className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan">{L.whoEyebrow}</span>
          <h2 className="mt-3 font-display text-4xl tracking-tight md:text-5xl">{L.whoH2}</h2>
          <div className="mt-10 grid grid-cols-2 gap-3 md:grid-cols-4">
            {L.segments.map((s, i) => (
              <div key={i} className="rounded-2xl border border-cream/12 bg-cream/[0.02] p-5">
                <span className="text-xl">{s[0]}</span>
                <div className="mt-2 font-semibold text-cream">{s[1]}</div>
                <div className="mt-1 text-[12.5px] text-cream/55">{s[2]}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* newsletter */}
      <section id="join" className="px-4 pb-24">
        <div className="mx-auto max-w-4xl rounded-[2.5rem] border border-cream/12 bg-gradient-to-br from-cyan/[0.10] to-lilac/[0.06] px-6 py-16 text-center md:px-14">
          <span className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan">{L.nlEyebrow}</span>
          <h2 className="mt-3 font-display text-4xl tracking-tight md:text-5xl">{L.nlH2}</h2>
          <p className="mx-auto mt-4 max-w-xl text-cream/60">{L.nlSub}</p>
          <form onSubmit={(e) => { e.preventDefault(); if (email.trim()) setDone(true); }} className="mx-auto mt-8 flex max-w-md flex-wrap justify-center gap-3">
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder={L.nlPlaceholder}
              className="min-w-[220px] flex-1 rounded-full border border-cream/15 bg-ink-deep/50 px-5 py-3.5 text-cream outline-none focus:border-cyan" />
            <button type="submit" className="rounded-full bg-cyan px-6 py-3.5 font-medium text-cyan-deep transition hover:brightness-110">{L.nlButton}</button>
          </form>
          <div className="mt-4 min-h-[20px] text-sm text-mint">{done ? L.nlDone : ""}</div>
          <p className="mt-1 text-[11px] text-cream/35">{L.nlMock}</p>
        </div>
      </section>

      <footer className="overflow-hidden px-6 pb-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 border-t border-cream/12 pt-8 text-sm text-cream/45 md:flex-row">
          <Link href="/japan" className="text-cream/80"><Wordmark size="text-base" /></Link>
          <span>{L.footer} · <Link href="/?geo=off" className="text-cream/70 hover:text-cream">{L.nav.global}</Link></span>
          <a href="mailto:hello@tembocommerce.com" className="underline">hello@tembocommerce.com</a>
        </div>
      </footer>
    </main>
  );
}
