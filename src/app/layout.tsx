import type { Metadata, Viewport } from "next";
import { PwaStatus } from "@/components/pwa-status";
import { cookies } from "next/headers";
import "@fontsource-variable/noto-sans";
import "./globals.css";
import "./tirekai.css";
import "./tirekai-v2.css";
export const metadata: Metadata = {
  title: "TirekAI | Бизнес кеңістігі",
  description: "Ұйым мен команданы басқаруға арналған жұмыс кеңістігі.",
  appleWebApp: { capable: true, title: "TirekAI", statusBarStyle: "default" },
  icons: {
    icon: [
      { url: "/icons/app.svg", type: "image/svg+xml" },
      { url: "/icons/app-192.png", sizes: "192x192" },
    ],
    apple: "/icons/app-192.png",
  },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#10283d",
};
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale =
    (await cookies()).get("smb_locale")?.value === "ru" ? "ru" : "kk";
  return (
    <html lang={locale}>
      <body>
        {children}
        <PwaStatus initialLocale={locale} />
      </body>
    </html>
  );
}
