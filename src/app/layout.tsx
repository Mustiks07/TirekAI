import type { Metadata } from "next";
import { cookies } from "next/headers";
import "@fontsource-variable/noto-sans";
import "./globals.css";
export const metadata: Metadata = {
  title: "Басқару | Бизнес кеңістігі",
  description: "Ұйым мен команданы басқаруға арналған жұмыс кеңістігі.",
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
      <body>{children}</body>
    </html>
  );
}
