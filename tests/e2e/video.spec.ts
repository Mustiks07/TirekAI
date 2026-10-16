import { test, expect, chromium, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

// T057 cameras in the browser: the in-app check on this device's camera (Chromium's fake camera;
// the server uses a stand-in detector that reports one person per frame — the screen contract,
// not recognition quality), drawing a line on the frame, the main screen without a processor, the
// token reissue warning, and phone width.
async function setup(page: Page) {
  const post = async (path: string, data: unknown) => {
    const r = await page.request.post(`/api/v1/${path}`, {
      headers: { origin: "http://127.0.0.1:3100" },
      data,
    });
    expect(r.ok(), await r.text()).toBe(true);
    return (await r.json()).data;
  };
  await post("auth/register", {
    name: "Камера тест",
    email: `video-${randomUUID()}@example.test`,
    password: "Browser-Synthetic-Video-661!",
  });
  await post("organizations", { name: "Cam", profile: "retail" });
  await page.goto("/");
  await page.getByRole("button", { name: "РУС", exact: true }).click();
}
async function openCameras(page: Page) {
  const nav = page.getByRole("navigation");
  if (!(await nav.isVisible()))
    await page.getByRole("button", { name: /^(Меню|Мәзір)$/ }).click();
  await nav.getByRole("button", { name: "Камеры", exact: true }).click();
}
test("check on this device's camera: people boxed and counted; stop releases the camera; a line is drawn on the frame", async () => {
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
    permissions: ["camera"],
  });
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
  await setup(page);
  await openCameras(page);
  // No cameras yet: the page points to the check instead of empty figures.
  await page
    .getByRole("button", { name: "Открыть проверку на видео", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Включить камеру этого устройства",
      exact: true,
    })
    .click();
  await expect(page.locator(".video-box.counted")).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(page.locator(".video-box span")).toContainText("Человек 1");
  const now = page.locator(".video-now strong");
  await expect(now).toHaveText("1");
  // Draw the entrance line with two clicks; counting starts again with it.
  await page
    .getByRole("button", { name: "Нарисовать линию входа", exact: true })
    .click();
  const stage = page.locator(".video-check .video-stage");
  const box = (await stage.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.1, box.y + box.height * 0.6);
  await page.mouse.click(box.x + box.width * 0.9, box.y + box.height * 0.6);
  await expect(page.locator(".video-check .video-line")).toHaveCount(1);
  await expect(now).toHaveText("1", { timeout: 30_000 });
  // Stop: every camera track ends.
  await page
    .getByRole("button", { name: "Остановить и выключить камеру", exact: true })
    .click();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __streams: MediaStream[] }).__streams
          .flatMap((s) => s.getTracks())
          .filter((t) => t.readyState === "live").length,
    ),
  ).toBe(0);
  expect(errors).toEqual([]);
  await browser.close();
});
test("main screen without a processor is honest; a reissued token is confirmed first; phone width has no overflow", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await setup(page);
  await openCameras(page);
  await page.getByText("Добавить камеру", { exact: true }).first().click();
  await page.getByLabel("Название", { exact: true }).fill("Вход");
  await page
    .getByRole("button", { name: "Добавить камеру", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Камера", exact: true }),
  ).toHaveValue(/.+/);
  await expect(page.getByText("Обработчик не подключён")).toBeVisible();
  // No data is not shown as zero people.
  await expect(page.locator(".video-now strong")).toHaveText(
    "Нет свежих данных",
  );
  // Settings: draw a line on the board and save a version.
  await page
    .getByRole("button", { name: "Настройки камеры", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Нарисовать линию", exact: true })
    .click();
  const stage = page.locator(".video-stage");
  const b = (await stage.boundingBox())!;
  await page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.1);
  await page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.9);
  await page.getByLabel("Что изменено").fill("Вход у двери");
  await page
    .getByRole("button", { name: "Сохранить новую версию разметки" })
    .click();
  await expect(page.getByText(/версия 1/)).toBeVisible();
  // Token: issued once; reissuing asks first and explains what happens.
  await page
    .getByRole("button", { name: "Выдать токен обработчика", exact: true })
    .click();
  await expect(page.locator(".video-command")).toContainText(
    "npm run video:processor",
  );
  await page.getByRole("button", { name: "Скрыть токен", exact: true }).click();
  await page
    .getByRole("button", { name: "Перевыпустить токен", exact: true })
    .click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "Старый токен перестанет работать сразу",
  );
  await page.getByRole("button", { name: "Отмена", exact: true }).click();
  // Phone: the main screen, settings and check fit the width.
  await page.setViewportSize({ width: 390, height: 844 });
  for (const tab of ["Обзор", "Настройки камеры", "Проверка на видео"]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, tab).toBeLessThanOrEqual(0);
  }
  expect(errors).toEqual([]);
});
