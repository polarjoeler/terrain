import type { Metadata } from "next";
import { Instrument_Serif, Inter } from "next/font/google";
import "./globals.css";

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
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
      className={`${instrumentSerif.variable} ${inter.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
