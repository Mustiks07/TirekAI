// Rehearsal of the demo in a real browser against the running local app (npm run preview after
// npm run demo:reset). It clicks through the same screens a presenter uses, records timings and
// screenshots, and checks the results through the API. It never answers for the AI model: the
// assistant scenario runs only when a provider is configured, otherwise it records that fact.
//   npm run demo:rehearse [-- --base http://127.0.0.1:3000 --out docs/demo/rehearsal]
import { chromium, expect, type Page, type Locator } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const base = arg("base", "http://127.0.0.1:3000"),
  out = arg("out", "docs/demo/rehearsal");
type Log = { scenario: string; step: string; ms: number; note?: string };
const log: Log[] = [];
let shot = 0;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
async function main() {
  const owner = JSON.parse(
    await readFile(".local/tirekai-business.json", "utf8"),
  ) as { email: string; password: string };
  const demo = JSON.parse(await readFile(".local/tirekai-demo.json", "utf8"))
    .approver as { email: string; password: string };
  const report = JSON.parse(
    await readFile(".local/tirekai-demo-report.json", "utf8"),
  );
  const org: string = report.organizationId;
  await mkdir(out, { recursive: true });
  const b = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  browser = b;
  const errors: string[] = [];
  const open = async (who: { email: string; password: string }) => {
    const context = await b.newContext({
      viewport: { width: 1440, height: 900 },
      baseURL: base,
    });
    context.setDefaultTimeout(20_000);
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    await page.getByRole("button", { name: "РУС", exact: true }).click();
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await page.getByLabel("Электронная почта", { exact: true }).fill(who.email);
    await page.getByLabel("Пароль", { exact: true }).fill(who.password);
    await page
      .locator("form")
      .getByRole("button", { name: "Войти", exact: true })
      .click();
    await expect(page.getByRole("heading", { name: "Сегодня" })).toBeVisible({
      timeout: 20_000,
    });
    return page;
  };
  const api = async (page: Page, path: string) => {
    const r = await page.request.get(`/api/v1/organizations/${org}/${path}`);
    if (!r.ok()) throw new Error(`GET ${path} ${r.status()}`);
    return (await r.json()).data;
  };
  const snap = (page: Page, name: string) =>
    page.screenshot({
      path: `${out}/${String(++shot).padStart(2, "0")}-${name}.png`,
    });
  const timed = async <T>(
    scenario: string,
    step: string,
    fn: () => Promise<T>,
  ) => {
    const t = Date.now();
    console.log(`→ ${scenario} · ${step}`);
    const r = await fn().catch(async (e) => {
      await snap(page, "failed");
      throw e;
    });
    log.push({ scenario, step, ms: Date.now() - t });
    return r;
  };
  const form = (page: Page, button: string): Locator =>
    page
      .locator("form")
      .filter({ has: page.getByRole("button", { name: button, exact: true }) });
  const nav = (page: Page, name: string) =>
    page
      .getByRole("navigation")
      .getByRole("button", { name, exact: true })
      .click();

  const page = await open(owner);
  const warehouse = (await api(page, "warehouses")).items.find(
    (w: { name: string }) => w.name === "Центральный склад",
  ).id;
  const stock = async (sku: string) =>
    (
      await api(page, `inventory/balances?warehouseId=${warehouse}&limit=100`)
    ).items.find((b: { sku: string }) => b.sku === sku)?.quantity ?? "0";

  // Scenario 1: invoice → OCR → review → physical receipt → stock.
  const S1 = "1. Накладная → приёмка";
  const before = { black: await stock("TM-001"), green: await stock("TM-002") };
  await timed(S1, "Открыть заказ поставщику", async () => {
    await nav(page, "Закупки");
    await page
      .getByRole("button", { name: /Тараз Снаб.*Отправлено вручную/ })
      .first()
      .click();
  });
  await timed(S1, "Загрузить скан и распознать (локальный OCR)", async () => {
    const f = form(page, "Загрузить и распознать");
    await f
      .locator('input[type="file"]')
      .setInputFiles("docs/demo/invoice-ts-1042.jpg");
    await f
      .getByRole("button", { name: "Загрузить и распознать", exact: true })
      .click();
    await expect(
      page.getByText("Распознанный текст", { exact: true }),
    ).toBeVisible({ timeout: 60_000 });
  });
  await snap(page, "ocr-result");
  let f = form(page, "Сохранить проверку документа");
  const prefilled = {
    number: await f.getByLabel("Номер документа", { exact: true }).inputValue(),
    date: await f.getByLabel("Дата документа", { exact: true }).inputValue(),
    quantities: await f
      .getByLabel("Количество в документе", { exact: true })
      .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value)),
    prices: await f
      .getByLabel("Цена за эту единицу, включая налоги, KZT", { exact: true })
      .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value)),
    delivery: await f.getByLabel("Доставка, KZT", { exact: true }).inputValue(),
    total: await f
      .getByLabel("Итог по оригиналу, KZT", { exact: true })
      .inputValue(),
  };
  log.push({
    scenario: S1,
    step: "Поля, подставленные из OCR",
    ms: 0,
    note: JSON.stringify(prefilled),
  });
  await timed(S1, "Проверить по оригиналу и подтвердить документ", async () => {
    await f
      .getByLabel("Срок оплаты", { exact: true })
      .fill(prefilled.date || new Date().toISOString().slice(0, 10));
    await f
      .getByRole("combobox", { name: "Результат проверки", exact: true })
      .selectOption("review");
    await f
      .getByLabel("Основание / комментарий", { exact: true })
      .fill("Сверено с оригиналом ТС-1042: цена чёрного чая выше заказа");
    await f
      .getByRole("button", {
        name: "Сохранить проверку документа",
        exact: true,
      })
      .click();
    // The price differs from the order (1 300 vs 1 250): the discrepancy must be acknowledged.
    await expect(
      page.getByText(/Есть расхождения с заказом/).first(),
    ).toBeVisible();
    await snap(page, "discrepancy");
    f = form(page, "Сохранить проверку документа");
    await f
      .getByLabel("Основание / комментарий", { exact: true })
      .fill("Новая цена поставщика согласована по телефону");
    await f.getByRole("checkbox", { name: /Проверены расхождения/ }).check();
    await f
      .getByRole("button", {
        name: "Сохранить проверку документа",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Подтвердить фактическую приёмку",
        exact: true,
      }),
    ).toBeVisible();
  });
  await timed(
    S1,
    "Подтвердить фактическую приёмку (зелёного чая 22 из 24)",
    async () => {
      f = form(page, "Подтвердить фактическую приёмку");
      const accepted = f.getByLabel(/Принято сейчас/);
      await accepted.nth(0).fill("40");
      await accepted.nth(1).fill("22");
      await f
        .getByLabel("Основание / комментарий", { exact: true })
        .fill("Пересчитано на складе: 2 пачки зелёного чая не доставлены");
      await f
        .getByRole("button", {
          name: "Подтвердить фактическую приёмку",
          exact: true,
        })
        .click();
      await expect(
        page.getByRole("heading", { name: /Закупка.*Частично принято/ }),
      ).toBeVisible();
    },
  );
  await snap(page, "receipt");
  const after = { black: await stock("TM-001"), green: await stock("TM-002") };
  log.push({
    scenario: S1,
    step: "Остаток Центрального склада до → после",
    ms: 0,
    note: JSON.stringify({ before, after }),
  });

  // Scenario 2: shortage → comparison → draft purchase → second-person approval → execution.
  const S2 = "2. Нехватка → закупка";
  const purchasesBefore = (await api(page, "purchases?limit=100")).items.length;
  const situation = page
    .locator("article.today-situation")
    .filter({ hasText: "TM-034" });
  await timed(S2, "Сегодня: открыть расчёт ситуации", async () => {
    await nav(page, "Сегодня");
    await situation.getByText("Расчёт и действия", { exact: true }).click();
    await expect(situation.getByText(/Тараз Снаб/).first()).toBeVisible();
  });
  await situation.scrollIntoViewIfNeeded();
  await snap(page, "situation");
  const offersShown = await timed(
    S2,
    "Сравнить все предложения на 25 пачек",
    async () => {
      await nav(page, "Закупки");
      await page
        .getByRole("button", { name: "Поставщики и прайсы", exact: true })
        .click();
      const cf = form(page, "Рассчитать полную стоимость");
      const option = await cf
        .getByRole("combobox", { name: "Товар", exact: true })
        .locator("option", { hasText: "TM-034" })
        .getAttribute("value");
      await cf
        .getByRole("combobox", { name: "Товар", exact: true })
        .selectOption(option!);
      await cf.getByLabel("Нужно базовых единиц", { exact: true }).fill("25");
      await cf
        .getByRole("button", {
          name: "Рассчитать полную стоимость",
          exact: true,
        })
        .click();
      await expect(
        page.locator("article.procurement-offer").first(),
      ).toBeVisible();
      return page.locator("article.procurement-offer").allInnerTexts();
    },
  );
  log.push({
    scenario: S2,
    step: "Предложения на экране",
    ms: 0,
    note: JSON.stringify(
      offersShown.map((x) => x.replace(/\s+/g, " ").slice(0, 160)),
    ),
  });
  await page
    .locator("article.procurement-offer")
    .first()
    .scrollIntoViewIfNeeded();
  await snap(page, "compare");
  await timed(S2, "Подготовить черновик закупки из ситуации", async () => {
    await nav(page, "Сегодня");
    await situation.getByText("Расчёт и действия", { exact: true }).click();
    await situation
      .getByRole("button", { name: "Подготовить закупку", exact: true })
      .click();
    await expect(page.getByText(/Черновик закупки создан/)).toBeVisible();
  });
  await timed(S2, "Отправить черновик на согласование", async () => {
    await nav(page, "Согласования");
    await page
      .getByRole("combobox", { name: "Показать", exact: true })
      .selectOption("draft");
    await page.locator("button.commerce-order").first().click();
    await expect(page.getByText(/TM-034/).first()).toBeVisible();
    await snap(page, "proposal-draft");
    await page
      .getByRole("button", { name: "Отправить на согласование", exact: true })
      .click();
    await expect(
      page.getByRole("heading", {
        name: /Предложение закупки · Ждёт согласования/,
      }),
    ).toBeVisible();
  });
  const approver = await open(demo);
  await timed(S2, "Второй человек согласует ту же версию", async () => {
    await nav(approver, "Согласования");
    await approver.locator("button.commerce-order").first().click();
    const df = form(approver, "Записать решение");
    await df
      .getByRole("combobox", { name: /Решение по версии/ })
      .selectOption("approve");
    await df
      .getByLabel("Основание", { exact: true })
      .fill("Склад пуст, поставщик выбран по полной стоимости");
    await df
      .getByRole("button", { name: "Записать решение", exact: true })
      .click();
    await expect(
      approver.getByRole("heading", {
        name: /Предложение закупки · Согласовано/,
      }),
    ).toBeVisible();
  });
  await snap(approver, "approved");
  await timed(
    S2,
    "Выполнить согласованное: создаётся закупочный заказ",
    async () => {
      await nav(page, "Согласования");
      await page
        .getByRole("combobox", { name: "Показать", exact: true })
        .selectOption("approved");
      await page.locator("button.commerce-order").first().click();
      await page
        .getByRole("button", { name: "Выполнить согласованное", exact: true })
        .click();
      await expect(page.getByText(/Результат:/).first()).toBeVisible();
    },
  );
  await snap(page, "executed");
  const purchases = (await api(page, "purchases?limit=100")).items;
  log.push({
    scenario: S2,
    step: "Закупочных заказов до → после; новый заказ",
    ms: 0,
    note: JSON.stringify({
      before: purchasesBefore,
      after: purchases.length,
      newest: purchases[0] && {
        supplier: purchases[0].supplier_name,
        state: purchases[0].state,
        total_minor: purchases[0].total_minor,
      },
    }),
  });

  // Scenario 3: questions in Kazakh and Russian. Expected numbers come from the calculation
  // layer at the moment of asking; the model's answer is recorded as given, never edited.
  const S3 = "3. Помощник KK/RU";
  const summary = await api(page, "finance/summary");
  const kzt = (minor: string) => {
    const v = BigInt(minor),
      sign = v < 0n ? "-" : "",
      a = v < 0n ? -v : v;
    return `${sign}${(a / 100n).toString()}.${String(a % 100n).padStart(2, "0")}`;
  };
  const expected = {
    cash: kzt(summary.cash_minor),
    receivable: kzt(summary.receivable_minor),
    payable: kzt(summary.payable_minor),
  };
  log.push({
    scenario: S3,
    step: "Ожидаемые суммы из расчётного слоя",
    ms: 0,
    note: JSON.stringify(expected),
  });
  const status = await api(page, "assistant");
  await nav(page, "Помощник");
  await snap(page, "assistant");
  if (status.provider.status !== "configured") {
    log.push({
      scenario: S3,
      step: "Модель не подключена: сценарий не выполнялся",
      ms: 0,
      note: "provider not_configured; задайте ASSISTANT_PROVIDER=free и ключи в .env.local (docs/AI_PROVIDERS.md)",
    });
  } else {
    const ask = async (locale: "kk" | "ru", question: string) => {
      await page
        .getByRole("combobox", { name: "Язык ответа", exact: true })
        .selectOption(locale);
      await page
        .getByLabel("Вопрос или поручение", { exact: true })
        .fill(question);
      await page
        .getByRole("button", { name: "Отправить", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Отправить", exact: true }),
      ).toBeVisible({ timeout: 180_000 });
      const conversations = (await api(page, "assistant/conversations")).items;
      const c = await api(
        page,
        `assistant/conversations/${conversations[0].id}`,
      );
      const m = c.messages.at(-1);
      const digits = (m.content as string)
        .replace(/[\s\u00a0]/g, "")
        .replace(/,/g, ".");
      return {
        status: m.status,
        tools: m.tool_calls.map((x: { name: string }) => x.name),
        sources: m.sources.length,
        unverified: m.unverified_numbers,
        mentions: Object.fromEntries(
          Object.entries(expected).map(([k, v]) => [
            k,
            digits.includes(v) || digits.includes(v.replace(/\.00$/, "")),
          ]),
        ),
        answer: m.content,
      };
    };
    const kk = await timed(S3, "Вопрос на казахском", () =>
      ask(
        "kk",
        "Шоттарда қанша ақша бар және клиенттер бізге қанша қарыз? Дереккөздерді көрсет.",
      ),
    );
    log.push({
      scenario: S3,
      step: "Ответ KK",
      ms: 0,
      note: JSON.stringify(kk),
    });
    await snap(page, "assistant-kk");
    const ru = await timed(S3, "Вопрос на русском", () =>
      ask(
        "ru",
        "Что срочно закончилось на складе и сколько мы должны поставщикам?",
      ),
    );
    log.push({
      scenario: S3,
      step: "Ответ RU",
      ms: 0,
      note: JSON.stringify(ru),
    });
    const draft = await timed(S3, "Предложение разрешённого действия", () =>
      ask(
        "ru",
        "Подготовь черновик закупки для ситуации с этикетками TM-036. Ничего не отправляй и не согласовывай.",
      ),
    );
    log.push({
      scenario: S3,
      step: "Черновик через инструмент (без согласования)",
      ms: 0,
      note: JSON.stringify(draft),
    });
    await snap(page, "assistant-draft");
  }

  await writeFile(
    `${out}/rehearsal.json`,
    JSON.stringify(
      { base, date: new Date().toISOString(), synthetic: true, log, errors },
      null,
      2,
    ),
  );
  for (const l of log)
    console.log(`${l.scenario} · ${l.step} · ${l.ms} ms ${l.note ?? ""}`);
  if (errors.length) console.log("Browser errors:", errors);
}
main()
  .catch((e) => {
    console.error("DEMO_REHEARSAL_FAILED", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => browser?.close());
