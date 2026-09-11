import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";

import "./globals.css";

// Self-hosted at build time rather than a <link> to Google: one less origin to
// connect to before the first paint, and the review queue gets opened on
// whatever laptop and whatever connection the person happens to be on.
const display = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-display-loaded",
  display: "swap",
});

const body = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-body-loaded",
  display: "swap",
});

// Figures, channel handles and API keys only — the things read character by
// character, and the things that have to line up in a column.
const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono-loaded",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ClipScout",
  description: "Find viral short-form videos by topic across platforms.",
  // An internal console holding a client's channel inventory and their
  // curation decisions. Nothing here belongs in a search index.
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${body.variable} ${mono.variable}`}
    >
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
