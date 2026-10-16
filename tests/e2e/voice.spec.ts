import { test, expect, chromium } from "@playwright/test";
import { randomUUID } from "node:crypto";

// T056 browser voice path: a fake Chromium microphone (a tone, not speech) is recorded, converted
// to 16 kHz WAV in the browser and sent; the server's local speech adapter talks to a protocol
// test double (tests/fixtures/fake-speech-worker.mjs) that returns a fixed Kazakh transcript with
// unsure words. This checks the UI contract, not recognition quality (see speech:eval).
test("voice transcript lands in the editable field and sending waits for checking unsure words", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });
  const context = await browser.newContext({
    baseURL: "http://127.0.0.1:3100",
    viewport: { width: 1440, height: 1000 },
    permissions: ["microphone"],
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const post = async (path: string, data: unknown) => {
    const r = await page.request.post(`/api/v1/${path}`, {
      headers: { origin: "http://127.0.0.1:3100" },
      data,
    });
    expect(r.ok(), await r.text()).toBe(true);
    return (await r.json()).data;
  };
  await post("auth/register", {
    name: "Голос тест",
    email: `voice-${randomUUID()}@example.test`,
    password: "Browser-Synthetic-Voice-661!",
  });
  const org = (
    await post("organizations", { name: "Voice", profile: "retail" })
  ).id;
  await post(`organizations/${org}/assistant/settings`, {
    version: 0,
    enabled: true,
    voiceEnabled: true,
    monthlyTokenBudget: 100000,
    maxOutputTokens: 2000,
  });
  await page.goto("/");
  await page.getByRole("button", { name: "РУС", exact: true }).click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Помощник", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Язык речи", exact: true })
    .selectOption("kk");
  await page
    .getByRole("button", { name: "Записать вопрос", exact: true })
    .click();
  await expect(page.getByText(/Микрофон включён, идёт запись/)).toBeVisible();
  await page.waitForTimeout(1500);
  await page
    .getByRole("button", { name: "Остановить и распознать", exact: true })
    .click();
  // By role: the wrapping label's text grows with the typed value, the accessible name does not.
  const field = page.getByRole("textbox", {
    name: "Вопрос или поручение",
    exact: true,
  });
  // Recording, browser WAV conversion and the server round trip; generous for slow CI machines.
  await expect(field).toHaveValue("Төлемді жүргізбе жиырма бес қорап", {
    timeout: 60_000,
  });
  // The negation and the unsure word must be checked before sending.
  await expect(
    page.getByText("жүргізбе, қорап", { exact: true }),
  ).toBeVisible();
  const send = page.getByRole("button", { name: "Отправить", exact: true });
  await expect(send).toBeDisabled();
  // The person corrects the text; sending still waits for the explicit check.
  await field.fill("Төлемді жүргізбе, жиырма бес қорап сүттің жобасын дайында");
  await expect(send).toBeDisabled();
  await page.getByRole("checkbox", { name: /Я проверил\(а\) суммы/ }).check();
  await expect(send).toBeEnabled();
  expect(errors).toEqual([]);
  await browser.close();
});
