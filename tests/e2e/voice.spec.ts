import { test, expect, chromium } from "@playwright/test";
import { randomUUID } from "node:crypto";

// T056 browser voice path: a fake Chromium microphone (a tone, not speech) is recorded, converted
// to 16 kHz WAV in the browser and sent; the server's local speech adapter talks to a protocol
// test double (tests/fixtures/fake-speech-worker.mjs) that returns a fixed Kazakh transcript with
// unsure words. This checks the UI contract, not recognition quality (see speech:eval).
test("a recognized question is sent once, shown in the dialog and can be corrected; cancel and errors send nothing", async () => {
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
  // Every microphone stream the page opens is kept, to check that it is released.
  await context.addInitScript(() => {
    const w = window as unknown as { __streams: MediaStream[] };
    w.__streams = [];
    const original = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (c) => {
      const stream = await original(c);
      w.__streams.push(stream);
      return stream;
    };
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const asks: { text: string; locale: string; voice?: unknown }[] = [],
    transcriptions: { locale: string }[] = [];
  page.on("request", (r) => {
    if (r.method() !== "POST") return;
    if (r.url().endsWith("/assistant/messages")) asks.push(r.postDataJSON());
    if (r.url().endsWith("/assistant/transcriptions"))
      transcriptions.push(r.postDataJSON());
  });
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
  const record = page.getByRole("button", {
    name: "Записать вопрос",
    exact: true,
  });
  const liveStreams = () =>
    page.evaluate(
      () =>
        (window as unknown as { __streams: MediaStream[] }).__streams
          .flatMap((s) => s.getTracks())
          .filter((t) => t.readyState === "live").length,
    );
  // 1) Cancel: the microphone is released and nothing is recognized or sent.
  await record.click();
  await expect(page.getByText(/Микрофон включён, идёт запись/)).toBeVisible();
  await page
    .getByRole("button", { name: "Отменить запись", exact: true })
    .click();
  await expect(record).toBeVisible();
  expect(await liveStreams()).toBe(0);
  expect(transcriptions).toHaveLength(0);
  expect(asks).toHaveLength(0);
  // 2) A recognition error sends nothing.
  await page.route("**/assistant/transcriptions", (route) =>
    route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "VOICE_EMPTY" } }),
    }),
  );
  await record.click();
  await page.waitForTimeout(700);
  await page
    .getByRole("button", { name: "Остановить и распознать", exact: true })
    .click();
  // Wait for the voice error itself (the page always has the route announcer alert), so the
  // mocked recognition is answered before the mock is removed.
  await expect(page.locator(".voice-panel [role=alert]")).toBeVisible({
    timeout: 30_000,
  });
  expect(asks).toHaveLength(0);
  expect(await liveStreams()).toBe(0);
  await page.unroute("**/assistant/transcriptions");
  // The refused recognition (Russian, the default) was requested once and sent nothing.
  expect(transcriptions.map((x) => x.locale)).toEqual(["ru"]);
  transcriptions.length = 0;
  // 3) Kazakh speech: recognized once and sent once, with the unsure words attached.
  await page
    .getByRole("combobox", { name: "Язык речи", exact: true })
    .selectOption("kk");
  await record.click();
  await page.waitForTimeout(1500);
  await page
    .getByRole("button", { name: "Остановить и распознать", exact: true })
    .click();
  expect(await liveStreams()).toBe(0);
  const spoken = "Төлемді жүргізбе жиырма бес қорап";
  // Recording, browser WAV conversion and the server round trip; generous for slow CI machines.
  await expect(
    page.locator(".assistant-message.user .assistant-text", {
      hasText: spoken,
    }),
  ).toBeVisible({ timeout: 60_000 });
  // No assistant is configured in this test: the answer is an honest "not configured".
  await expect(page.locator(".assistant-message.assistant")).toBeVisible();
  expect(transcriptions.map((x) => x.locale)).toEqual(["kk"]);
  expect(asks).toHaveLength(1);
  expect(asks[0]).toMatchObject({
    text: spoken,
    voice: { uncertain: ["жүргізбе", "қорап"] },
  });
  // No check box and no blocking warning about unsure words.
  await expect(page.getByRole("checkbox", { name: /Я проверил/ })).toHaveCount(
    0,
  );
  // 4) Correct and send again: one more request with the edited text.
  await page
    .getByRole("button", { name: "Исправить и отправить заново", exact: true })
    .first()
    .click();
  const field = page.getByRole("textbox", {
    name: "Вопрос или поручение",
    exact: true,
  });
  await expect(field).toHaveValue(spoken);
  await field.fill("Төлемді жүргізбе, жиырма бес қорап сүт");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(
    page.locator(".assistant-message.user .assistant-text", {
      hasText: "жиырма бес қорап сүт",
    }),
  ).toBeVisible({ timeout: 30_000 });
  expect(asks).toHaveLength(2);
  expect(asks[1]).not.toHaveProperty("voice");
  expect(errors).toEqual([]);
  await browser.close();
});
