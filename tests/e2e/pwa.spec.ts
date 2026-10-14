import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
test("install manifest, offline recovery and no business data in browser caches", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "РУС", exact: true }).click();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    )
    .toBe(true);
  const manifest = await (
    await page.request.get("/manifest.webmanifest")
  ).json();
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toContain(
    "512x512",
  );
  const session = await context.newCDPSession(page);
  const appManifest = await session.send("Page.getAppManifest");
  expect(appManifest.errors).toEqual([]);
  await session.detach();
  await page.evaluate(() => fetch("/api/v1/session").then((r) => r.json()));
  await page.reload();
  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    return Promise.all(
      names.map(async (name) => ({
        name,
        urls: (await (await caches.open(name)).keys()).map(
          (r) => new URL(r.url).pathname,
        ),
      })),
    );
  });
  expect(cached).toHaveLength(1);
  expect(cached[0].urls.sort()).toEqual(
    [
      "/icons/app-192.png",
      "/icons/app-512.png",
      "/icons/app-maskable.png",
      "/offline.html",
    ].sort(),
  );
  await context.setOffline(true);
  await expect(page.getByText("Нет сети.", { exact: false })).toBeVisible();
  expect(
    await page.evaluate(() =>
      fetch("/api/v1/session").then(
        () => false,
        () => true,
      ),
    ),
  ).toBe(true);
  await page.goto("/?offline-test=1");
  await expect(
    page.getByRole("heading", { name: "Нет соединения", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Данные и операции недоступны", { exact: false }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "ҚАЗ", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Байланыс жоқ", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "docs/evidence/offline-kk.png",
    fullPage: true,
  });
  await context.setOffline(false);
  await page.getByRole("link", { name: "Қайта ашу", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Создать аккаунт", exact: true }),
  ).toBeVisible();
});
