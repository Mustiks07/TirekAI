import { it, expect } from "vitest";
import { organizationInstant } from "../src/lib/industry-i18n";
it("uses organization timezone and rejects DST gaps and folds", () => {
  expect(organizationInstant("2026-10-15T14:20", "Asia/Qyzylorda")).toBe(
    "2026-10-15T09:20:00.000Z",
  );
  expect(() =>
    organizationInstant("2026-03-08T02:30", "America/New_York"),
  ).toThrow("INVALID_LOCAL_TIME");
  expect(() =>
    organizationInstant("2026-11-01T01:30", "America/New_York"),
  ).toThrow("INVALID_LOCAL_TIME");
});
