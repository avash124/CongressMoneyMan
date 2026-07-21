import type { Metadata } from "next";
import { Public_Sans, IBM_Plex_Mono, Libre_Bodoni } from "next/font/google";
import "./globals.css";
import Navbar from "./components/NavigationBar";

// UI / body — Public Sans is the U.S. federal design system's own typeface.
const publicSans = Public_Sans({
  variable: "--font-public-sans",
  subsets: ["latin"],
  display: "swap",
});

// Data / ledger figures.
const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-ibm-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

// Masthead / display — a Didone with the voice of engraved financial print.
const libreBodoni = Libre_Bodoni({
  variable: "--font-libre-bodoni",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Uncle Sam's Stockings — Congress financial transparency",
  description:
    "Every disclosed congressional trade, dollar of net worth, and PAC check — consolidated, sourced, and turned into a forward read on what members trade next.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body
        className={`${publicSans.variable} ${ibmPlexMono.variable} ${libreBodoni.variable} antialiased`}
      >
        <Navbar />

        <div className="max-w-7xl mx-auto px-6 py-10">
          {children}
        </div>
      </body>
    </html>
  );
}