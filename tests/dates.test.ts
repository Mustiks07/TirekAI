import { expect, it } from "vitest";
import { businessDate } from "../src/lib/dates";

it("uses Kazakh month names rather than browser ICU placeholders", () => {
  expect(businessDate(new Date("2026-10-14T08:28:00Z"), "kk", "Asia/Qyzylorda", true)).toBe("14 қазан, 13:28");
});
it("uses Russian grammatical month names", () => {
  expect(businessDate(new Date("2026-10-14T08:28:00Z"), "ru", "Asia/Qyzylorda")).toBe("14 октября");
});
it("uses the organization's local calendar day at a month boundary", () => {
  expect(businessDate(new Date("2026-10-31T23:30:00Z"), "kk", "Asia/Qyzylorda", true)).toBe("1 қараша, 04:30");
});
it("preserves midnight as 00 and honors UTC", () => {
  expect(businessDate(new Date("2026-01-01T00:00:00Z"), "ru", "UTC", true)).toBe("1 января, 00:00");
});
