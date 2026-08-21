import type { Metadata } from "next";
import { Hanken_Grotesk, Source_Serif_4, JetBrains_Mono } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { AppShell } from "@/components/app-shell";
import "./globals.css";

/**
 * Anthropic's typography, as closely as licensed fonts allow.
 *
 * The brand uses Styrene for UI text and Tiempos/Copernicus for display, neither
 * of which can be redistributed. Hanken Grotesk and Source Serif 4 are the
 * closest open equivalents: the same neo-grotesque proportions and a
 * transitional serif with comparable contrast.
 */
const sans = Hanken_Grotesk({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

const serif = Source_Serif_4({
  variable: "--font-serif",
  subsets: ["latin"],
  display: "swap",
});

// Numbers sit in tables and have to line up, so the mono face is used for every
// rate, price and size in the app.
const mono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Funding Rate Market",
  description: "Compare perpetual funding rates, manage accounts and automation.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`dark ${sans.variable} ${serif.variable} ${mono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full bg-background text-foreground">
        <TooltipProvider>
          <AppShell>{children}</AppShell>
        </TooltipProvider>
        <Toaster />
      </body>
    </html>
  );
}
