import type { Locale } from "../domain/contracts";

const months = {
  kk: [
    "қаңтар",
    "ақпан",
    "наурыз",
    "сәуір",
    "мамыр",
    "маусым",
    "шілде",
    "тамыз",
    "қыркүйек",
    "қазан",
    "қараша",
    "желтоқсан",
  ],
  ru: [
    "января",
    "февраля",
    "марта",
    "апреля",
    "мая",
    "июня",
    "июля",
    "августа",
    "сентября",
    "октября",
    "ноября",
    "декабря",
  ],
};

// Some browser ICU builds expose placeholder Kazakh month names (e.g. M10).
// Use Intl for timezone conversion, and our translation catalogue for month names.
export function businessDate(
  date: Date,
  locale: Locale,
  timeZone: string,
  withTime = false,
) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (name: string) =>
    parts.find((p) => p.type === name)?.value || "";
  return `${Number(part("day"))} ${months[locale][Number(part("month")) - 1]}${withTime ? `, ${part("hour")}:${part("minute")}` : ""}`;
}
