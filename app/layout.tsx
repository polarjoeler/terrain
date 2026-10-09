import type { Metadata } from "next";
import { Bricolage_Grotesque, Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Terrain's type system: a characterful grotesque display (Bricolage), a clean neutral body
// (Hanken Grotesk), and a monospace for data/tickers (JetBrains Mono) — distinctive and ownable,
// away from the generic editorial-serif + Inter default.
const display = Bricolage_Grotesque({
  variable: "--font-display-face",
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
  display: "swap",
});
const body = Hanken_Grotesk({
  variable: "--font-body-face",
  subsets: ["latin"],
  display: "swap",
});
const mono = JetBrains_Mono({
  variable: "--font-mono-face",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
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
