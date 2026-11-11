import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Terrain's type system: a characterful grotesque display (Bricolage), a clean neutral body
// (Hanken Grotesk), and a monospace for data/tickers (JetBrains Mono) — distinctive and ownable,
// away from the generic editorial-serif + Inter default.
//
// SELF-HOSTED from app/fonts, not next/font/google. The Google loader fetches the font binaries
// from fonts.gstatic.com AT BUILD TIME, so every deploy depended on that fetch: a transient failure
// fails the whole build with a module-not-found on an internal CSS shim, saying nothing about the
// network. It cost one of two deploys on 2026-11-11. Committed files mean a build needs no network
// and renders identically every time.
//
// These are BYTE-FOR-BYTE the files the loader was fetching — verified by sha256 against what
// fonts.gstatic.com serves for this exact config. Each family is ONE weight-variable woff2 with the
// other axes pinned, which is what Google returns for `wght@500;600;700;800`: all four of its
// @font-face rules point at the same file. So the repeated `path` below is correct, not a mistake,
// and it reproduces the original declarations exactly. (next/font/local requires every value to be
// a written literal, so the path cannot be hoisted into a const.)
//
// Do NOT "simplify" this to one src with weight: "500 800". Asking css2 for the opsz/wdth axes
// returns a DIFFERENT file, and with font-optical-sizing:auto the display face then renders ~6.6%
// narrower at headline sizes (994.83px -> 928.89px for the h1 string at 64px/800), which reflows
// the homepage headline. Discrete weights against the pinned file is what keeps the type identical.
//
// Latin subset only, matching the previous subsets:["latin"]. All three are SIL OFL 1.1 and the
// licences sit beside them, as the licence requires. Versions: Bricolage v9, Hanken v12,
// JetBrains Mono v24. To refresh, re-fetch
// https://fonts.googleapis.com/css2?family=<Family>:wght@<same spec>&display=swap with a browser
// UA and take the @font-face block whose unicode-range contains U+0000-00FF.
const display = localFont({
  src: [
    { path: "./fonts/bricolage-grotesque-latin.woff2", weight: "500", style: "normal" },
    { path: "./fonts/bricolage-grotesque-latin.woff2", weight: "600", style: "normal" },
    { path: "./fonts/bricolage-grotesque-latin.woff2", weight: "700", style: "normal" },
    { path: "./fonts/bricolage-grotesque-latin.woff2", weight: "800", style: "normal" },
  ],
  variable: "--font-display-face",
  display: "swap",
});
const body = localFont({
  // Hanken Grotesk was requested without an explicit weight, so the loader served the full
  // variable range as a single face. Unchanged here.
  src: "./fonts/hanken-grotesk-latin.woff2",
  variable: "--font-body-face",
  weight: "100 900",
  display: "swap",
});
const mono = localFont({
  src: [
    { path: "./fonts/jetbrains-mono-latin.woff2", weight: "400", style: "normal" },
    { path: "./fonts/jetbrains-mono-latin.woff2", weight: "500", style: "normal" },
    { path: "./fonts/jetbrains-mono-latin.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-mono-face",
  display: "swap",
});

// Absolute-URL base for canonical links and OG/Twitter cards. Driven by
// NEXT_PUBLIC_SITE_URL so a domain move is an env change, not a code change.
export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://terrain.tembocommerce.app"),
  title: "Terrain — Every new Shopify store in Africa, found first",
  description:
    "Terrain maps new African Shopify stores the day they launch — enriched with contact details, pricing, payment stacks and more — delivered weekly. Part of the Tembo Commerce family.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${body.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
