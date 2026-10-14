import { cookies } from "next/headers";
import { PlatformApp } from "@/components/platform-app";
export default async function Page() {
  const locale =
    (await cookies()).get("smb_locale")?.value === "ru" ? "ru" : "kk";
  return <PlatformApp initialLocale={locale} />;
}
