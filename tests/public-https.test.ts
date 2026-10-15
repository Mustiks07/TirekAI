import { it, expect } from "vitest";
import {
  publicAddress,
  publicHttps,
} from "../src/server/integrations/public-https";
import { validInfobaseUrl } from "../src/server/integrations/onec";
it("rejects private IPv4, IPv6 and mapped literals before a 1C connection", async () => {
  for (const host of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "100.64.0.1",
    "[::1]",
    "[fd00::1]",
    "[::ffff:127.0.0.1]",
    "[::ffff:a9fe:a9fe]",
  ]) {
    expect(publicAddress(host)).toBe(false);
    expect(validInfobaseUrl(`https://${host}/trade`)).toBe(false);
    await expect(publicHttps(`https://${host}/trade`)).rejects.toMatchObject({
      code: "ONEC_HOST_NOT_ALLOWED",
    });
  }
  expect(publicAddress("8.8.8.8")).toBe(true);
  expect(publicAddress("2606:4700:4700::1111")).toBe(true);
});
