import type { Metadata, Viewport } from "next";

import { MobileNavigation } from "@/components/mobile-navigation";
import "./globals.css";

export const metadata: Metadata = {
  title: "Health Web App",
  description: "個人向けの健康・食事・習慣管理PWA",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <a href="#main-content">本文へ移動</a>
        {children}
        <MobileNavigation />
      </body>
    </html>
  );
}
