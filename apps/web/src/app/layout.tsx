import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { AppShell } from "@/components/AppShell";
// eslint-disable-next-line import/no-unassigned-import -- global stylesheet, imported for its side effect
import "./globals.css";

export const metadata: Metadata = {
  title: "i-bot",
  description: "Computer-use bots on isolated cloud desktops.",
  // The browser-tab favicon comes from the App Router convention file `app/icon.png` (the project
  // logo), which Next auto-links with a content hash — no manual `icons` entry needed.
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
