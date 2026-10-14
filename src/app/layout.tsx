import type { Metadata, Viewport } from "next";
import { PwaStatus } from "@/components/pwa-status";
import { cookies } from "next/headers";
import "@fontsource-variable/noto-sans";
import "./globals.css";
export const metadata: Metadata = {
  title: "Басқару | Бизнес кеңістігі",
  description: "Ұйым мен команданы басқаруға арналған жұмыс кеңістігі.",
  appleWebApp: { capable: true, title: "Басқару", statusBarStyle: "default" },
  icons: { icon: "/icons/app-192.png", apple: "/icons/app-192.png" },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#244936",
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
