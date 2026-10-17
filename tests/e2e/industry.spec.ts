import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID as key } from "node:crypto";
const past = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
async function setup(page: Page, profile: string) {
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
  const get = async (path: string) => {
    const r = await page.request.get(`/api/v1/${path}`);
    expect(r.ok(), await r.text()).toBe(true);
    return (await r.json()).data;
  };
  await post("auth/register", {
    name: "Профили тест",
    email: `industry-${key()}@example.test`,
    password: "Browser-Industry-661!",
  });
  const org = (
      await post("organizations", { name: `Taraz ${profile}`, profile })
    ).id,
    base = `organizations/${org}`,
    workspace = await get(base),
    branch = workspace.branches[0].id;
  const warehouse = (
    await post(`${base}/warehouses`, {
      branchId: branch,
      name: "Основной склад",
    })
  ).id;
  const item = async (kind: string, name: string) =>
    (
      await post(`${base}/catalog`, {
        sku: key(),
        name_ru: name,
        name_kk: name,
        kind,
        base_unit: "pc",
        purchase_price: "2",
        sale_price: "100",
      })
    ).id;
  const material = await item("goods", "Материал"),
    product = await item("goods", "Готовый товар"),
    service = await item("service", "Консультация");
  const customer = (
    await post(`${base}/crm/customers`, {
      key: key(),
      branchId: branch,
      name: "Тестовый клиент",
      email: "",
      phone: "",
      kind: "person",
      responsibleId: null,
      consents: { email: false, sms: false, messenger: false },
      consentNote: "Тестовые данные",
    })
  ).id;
  const command = (data: Record<string, unknown>) =>
    post(`${base}/industry/commands`, {
      key: key(),
      branchId: branch,
      ...data,
    });
  const resource = async (kind: string) =>
    (
      await command({
        kind: "resource",
        title: kind,
        resourceKind: kind,
        capacity: 1,
        bufferMinutes: 0,
        days: [1, 2, 3, 4, 5, 6, 7],
        opens: "00:00",
        closes: "23:59",
      })
    ).id;
  const open = async () => {
    await page.goto("/");
    await page.getByRole("button", { name: "РУС", exact: true }).click();
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "Работа по профилю", exact: true })
      .click();
    await expect(page.getByText("Загрузка…", { exact: true })).toHaveCount(0);
  };
  const click = async (name: string) => {
    await page
      .locator(".industry-page")
      .getByRole("button", { name, exact: true })
      .click();
    return page.getByRole("form", { name, exact: true });
  };
  const submit = async (name: string) => {
    const form = page.getByRole("form", { name, exact: true });
    const note = form.getByLabel("Основание / подтверждение", { exact: true });
    if (await note.count()) await note.fill("Подтверждение тестового сценария");
    await form.getByRole("button", { name, exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(page.locator(".industry-page [role=alert]")).toHaveCount(0);
  };
  const docs = async () =>
    (await get(`${base}/industry?branchId=${branch}`)).items as {
      id: string;
      kind: string;
      state: string;
      version: number;
      data: Record<string, unknown>;
    }[];
  const capture = async () => {
    await expect(page.locator(".industry-page")).toBeVisible();
    await page.screenshot({
      path: `docs/evidence/industry-${profile}-ru.png`,
      fullPage: true,
    });
    expect(
      (await new AxeBuilder({ page }).include(".industry-page").analyze())
        .violations,
    ).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "ҚАЗ", exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await page.screenshot({
      path: `docs/evidence/industry-${profile}-kk-mobile.png`,
      fullPage: true,
    });
    expect(
      (await new AxeBuilder({ page }).include(".industry-page").analyze())
        .violations,
    ).toEqual([]);
    expect(errors).toEqual([]);
  };
  return {
    post,
    get,
    base,
    workspace,
    branch,
    warehouse,
    material,
    product,
    service,
    customer,
    command,
    resource,
    open,
    click,
    submit,
    docs,
    capture,
  };
}
test("clinic: private request, appointment, visit and invoice through RU/KK mobile forms", async ({
  page,
}) => {
  const f = await setup(page, "clinic"),
    specialist = await f.resource("specialist"),
    room = await f.resource("room");
  await f.open();
  let form = await f.click("Административная заявка");
  await form
    .getByLabel("Имя пациента (административный учёт)", { exact: true })
    .fill("Пациент синтетический");
  await form
    .getByLabel("Направление услуги", { exact: true })
    .selectOption(f.service);
  await form
    .getByLabel("Подразделение расчёта", { exact: true })
    .selectOption(f.warehouse);
  await form.getByLabel("Стоимость посещения, ₸", { exact: true }).fill("100");
  await f.submit("Административная заявка");
  await page
    .locator(".industry-card")
    .filter({ hasText: "Приём / Қабылдау" })
    .click();
  form = await f.click("Записать / перенести посещение");
  await form.getByLabel(/^Начало \(/).fill(`${past}T14:00`);
  await form.getByLabel(/^Конец \(/).fill(`${past}T15:00`);
  await form
    .getByLabel("Ресурсы: выберите специалиста и место", { exact: true })
    .selectOption([specialist, room]);
  await f.submit("Записать / перенести посещение");
  form = await f.click("Отметить посещение");
  await form
    .getByLabel("Итог посещения", { exact: true })
    .selectOption("visited");
  await f.submit("Отметить посещение");
  await f.click("Выставить счёт за посещение");
  await f.submit("Выставить счёт за посещение");
  const doc = (await f.docs()).find((d) => d.kind === "clinic")!;
  expect(doc.state).toBe("completed");
  await f.capture();
  await page.getByRole("button", { name: "РУС", exact: true }).click();
  await page.getByRole("button", { name: "Меню", exact: true }).click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Продажи", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Результаты: прогноз → действие → факт",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Пациент синтетический", { exact: false }),
  ).toHaveCount(0);
  await expect(page.locator(".outcomes-page").getByRole("alert")).toHaveCount(
    0,
  );
  await expect(
    page.getByText("100.00 ₸", { exact: false }).first(),
  ).toBeVisible();
  await page.screenshot({
    path: "docs/evidence/outcomes-ru-mobile.png",
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const response = await page.request.get("/");
  expect(response.headers()["content-security-policy"]).toContain(
    "object-src 'none'",
  );
});
test("construction: estimate, second approver, procurement, verified contractor works and acceptance", async ({
  page,
  browser,
}) => {
  test.setTimeout(120000);
  const f = await setup(page, "construction"),
    today = new Date().toISOString().slice(0, 10);
  const other = await browser.newContext({ baseURL: "http://127.0.0.1:3100" });
  try {
    const managerPost = async (path: string, data: unknown) => {
      const r = await other.request.post(`/api/v1/${path}`, {
        headers: { origin: "http://127.0.0.1:3100" },
        data,
      });
      expect(r.ok(), await r.text()).toBe(true);
      return (await r.json()).data;
    };
    const email = `manager-${key()}@example.test`;
    await managerPost("auth/register", {
      name: "Проверяющий",
      email,
      password: "Browser-Industry-661!",
    });
    const inv = await f.post(`${f.base}/invitations`, {
      email,
      role: "manager",
      branchId: f.branch,
    });
    await managerPost("invitations/accept", { token: inv.token });
    const supplier = (
      await f.post(`${f.base}/suppliers`, {
        key: key(),
        name: "Подрядчик",
        contact: "",
        paymentTerms: "После приёмки",
        reliability: 4,
        quality: 4,
      })
    ).id;
    await f.post(`${f.base}/supplier-offers`, {
      key: key(),
      supplierId: supplier,
      itemId: f.material,
      supplierSku: "Материал",
      packQuantity: "1",
      baseUnit: "pc",
      packPrice: "10",
      minimumPacks: 1,
      delivery: "0",
      leadDays: 1,
      currency: "KZT",
      rate: null,
      rateDate: null,
      rateSource: "",
      tax: "included",
      taxPercent: null,
      dated: today,
      validUntil: "2099-12-31",
      characteristicsConfirmed: true,
      note: "Тест",
    });
    await f.open();
    let form = await f.click("Создать объект и смету");
    await form
      .getByLabel("Объект строительства", { exact: true })
      .fill("Новый объект");
    await form.getByLabel("Заказчик", { exact: true }).selectOption(f.customer);
    await form
      .getByLabel("Склад объекта", { exact: true })
      .selectOption(f.warehouse);
    await form
      .getByLabel("Услуга для итогового счёта", { exact: true })
      .selectOption(f.service);
    await form.getByLabel("Бюджет затрат, ₸", { exact: true }).fill("100");
    await form
      .getByLabel("Этапы, через запятую", { exact: true })
      .fill("Монтаж");
    await form
      .getByLabel("Позиция сметы 1", { exact: true })
      .selectOption(f.material);
    await form.getByLabel("Цена по смете, ₸ 1", { exact: true }).fill("100");
    await f.submit("Создать объект и смету");
    let doc = (await f.docs()).find((d) => d.kind === "construction")!;
    const approve = async (
      kind: string,
      extra: Record<string, unknown> = {},
    ) => {
      doc = (await f.docs()).find((d) => d.id === doc.id)!;
      await managerPost(`${f.base}/industry/commands`, {
        key: key(),
        id: doc.id,
        version: doc.version,
        kind,
        note: "Проверено другим сотрудником",
        ...extra,
      });
    };
    await approve("construction_approve");
    await f.open();
    await page
      .locator(".industry-card")
      .filter({ hasText: "Новый объект" })
      .click();
    form = await f.click("Создать закупку объекта");
    await form.getByLabel("Поставщик", { exact: true }).selectOption(supplier);
    await expect(
      form
        .getByLabel("Предложение поставщика", { exact: true })
        .locator("option"),
    ).toHaveCount(2);
    await form
      .getByLabel("Предложение поставщика", { exact: true })
      .selectOption({ index: 1 });
    await form.getByLabel("Дата предложения", { exact: true }).fill(today);
    await form.getByLabel("Срок поставки", { exact: true }).fill(today);
    await f.submit("Создать закупку объекта");
    doc = (await f.docs()).find((d) => d.id === doc.id)!;
    const purchase = (doc.data.purchases as string[])[0];
    for (const kind of ["submit", "approve", "sent"])
      await f.post(`${f.base}/purchases/${purchase}/commands`, {
        key: key(),
        version: (await f.get(`${f.base}/purchases/${purchase}`)).order.version,
        kind,
        note: "Тестовая закупка",
      });
    const receipt = (
      await f.post(`${f.base}/purchase-documents`, {
        key: key(),
        orderId: purchase,
        filename: "test.csv",
        content: Buffer.from(
          "name,quantity,unit,price\nМатериал,1,pc,10",
        ).toString("base64"),
        externalId: "",
      })
    ).id;
    await f.post(`${f.base}/purchase-documents/${receipt}/review`, {
      key: key(),
      version: 1,
      number: key(),
      date: today,
      dueDate: today,
      delivery: "0",
      total: "10",
      lines: [
        {
          itemId: f.material,
          name: "Материал",
          unit: "pc",
          quantity: "1",
          unitPrice: "10",
        },
      ],
      note: "Проверено",
      acknowledgeDiscrepancies: true,
    });
    const invoice = await f.get(`${f.base}/purchase-documents/${receipt}`);
    await f.post(`${f.base}/purchases/${purchase}/receipts`, {
      key: key(),
      version: (await f.get(`${f.base}/purchases/${purchase}`)).order.version,
      documentId: receipt,
      note: "Приёмка",
      lines: [{ lineId: invoice.lines[0].id, quantity: "1" }],
    });
    form = await f.click("Выдать материалы на объект");
    await form
      .getByLabel("Материал 1", { exact: true })
      .selectOption(f.material);
    await f.submit("Выдать материалы на объект");
    form = await f.click("Зафиксировать работы");
    await form.getByLabel("Подрядчик", { exact: true }).selectOption(supplier);
    await form.getByLabel("Этап", { exact: true }).selectOption("0");
    await form.getByLabel("Стоимость работ, ₸", { exact: true }).fill("20");
    await form
      .getByLabel("Подтверждение выполненного объёма", { exact: true })
      .fill("Монтаж завершён");
    await f.submit("Зафиксировать работы");
    doc = (await f.docs()).find((d) => d.id === doc.id)!;
    await approve("construction_confirm", {
      workId: (doc.data.work as { id: string }[])[0].id,
    });
    await f.open();
    await page
      .locator(".industry-card")
      .filter({ hasText: "Новый объект" })
      .click();
    await f.click("Принять объект и выставить счёт");
    await f.submit("Принять объект и выставить счёт");
    expect((await f.docs()).find((d) => d.id === doc.id)?.state).toBe(
      "completed",
    );
    await f.capture();
    await page.getByRole("button", { name: "РУС", exact: true }).click();
    await page
      .getByRole("button", { name: "Открыть закупку и приёмку 1", exact: true })
      .click();
    await expect(page.locator(".commerce-order.active")).toHaveCount(1);
  } finally {
    await other.close();
  }
});
test("outcomes: save a forecast before fulfillment and inspect distinct facts in RU/KK", async ({
  page,
}) => {
  const f = await setup(page, "retail"),
    today = new Date().toISOString().slice(0, 10);
  const order = (
    await f.post(`${f.base}/orders`, {
      key: key(),
      branchId: f.branch,
      customerId: f.customer,
      warehouseId: f.warehouse,
      dueDate: today,
      delivery: "pickup",
      taxMode: "excluded",
      note: "Тест",
      lines: [
        {
          itemId: f.service,
          quantity: "1",
          unit: "pc",
          price: "100",
          discount: "0",
        },
      ],
    })
  ).id;
  const open = async () => {
    await page.goto("/");
    await page.getByRole("button", { name: "РУС", exact: true }).click();
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "Продажи", exact: true })
      .click();
    await expect(page.getByText("Загрузка…", { exact: true })).toHaveCount(0);
  };
  await open();
  await page
    .getByText("Зафиксировать прогноз до исполнения", { exact: true })
    .click();
  await page
    .getByLabel("Исходный документ (последние 100)", { exact: true })
    .selectOption(order);
  await page
    .getByLabel("Прогноз выручки / экономии, ₸ (необязательно)", {
      exact: true,
    })
    .fill("120");
  await page
    .getByLabel("Условия сравнения и ограничения вывода", { exact: true })
    .fill("Без доказательства причинности, сезонность не учтена.");
  await page
    .getByRole("button", { name: "Сохранить исходное сравнение", exact: true })
    .click();
  await expect(
    page.getByText("Исходное сравнение сохранено.", { exact: true }),
  ).toBeVisible();
  await f.post(`${f.base}/orders/${order}/commands`, {
    key: key(),
    version: 1,
    kind: "confirm",
    note: "Тест",
  });
  const line = (await f.get(`${f.base}/orders/${order}`)).lines[0].id;
  await f.post(`${f.base}/orders/${order}/commands`, {
    key: key(),
    version: 2,
    kind: "fulfill",
    lineId: line,
    quantity: "1",
    serviceCost: "10",
    note: "Тест",
  });
  await open();
  await page.getByText(`${order} · Измерено`, { exact: true }).click();
  await expect(
    page.getByText(/Отклонение от прогноза \/ экономия закупки: -20.00/),
  ).toBeVisible();
  await expect(page.locator(".outcomes-page").getByRole("alert")).toHaveCount(
    0,
  );
  await page.screenshot({
    path: "docs/evidence/outcomes-ru.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "ҚАЗ", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Нәтижелер: болжам → әрекет → факт",
      exact: true,
    }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: "docs/evidence/outcomes-kk-mobile.png",
    fullPage: true,
  });
});
for (const profile of ["food", "production"])
  test(`${profile}: recipe, plan, material issue, stages and output lot through the UI`, async ({
    page,
  }) => {
    const f = await setup(page, profile);
    await f.command({
      kind: "lot_receipt",
      warehouseId: f.warehouse,
      itemId: f.material,
      quantity: "10",
      unit: "pc",
      unitCost: "2",
      lotCode: "RAW-01",
      expiresOn: "2099-12-31",
      note: "Тестовая партия",
    });
    await f.open();
    let form = await f.click("Рецептура / спецификация");
    await form
      .getByLabel("Название", { exact: true })
      .fill("Проверяемая рецептура");
    await form
      .getByLabel("Готовый товар", { exact: true })
      .selectOption(f.product);
    await form
      .getByLabel("Выход в базовых единицах", { exact: true })
      .fill("2");
    await form
      .getByLabel("Этапы, через запятую", { exact: true })
      .fill("Подготовка, Выпуск");
    await form
      .getByLabel("Материал 1", { exact: true })
      .selectOption(f.material);
    await form.getByLabel("Количество", { exact: true }).fill("2");
    await f.submit("Рецептура / спецификация");
    const recipe = (await f.docs()).find((x) => x.kind === "recipe")!.id;
    form = await f.click("План выпуска");
    await form.getByLabel("Склад", { exact: true }).selectOption(f.warehouse);
    await form
      .getByLabel("Рецептура / спецификация", { exact: true })
      .selectOption(recipe);
    await form.getByLabel("План выпуска", { exact: true }).fill("2");
    await f.submit("План выпуска");
    await page
      .locator(".industry-card")
      .filter({ hasText: "Запланировано" })
      .click();
    form = await f.click("Выдать материалы");
    await expect(form.getByLabel("Количество", { exact: true })).toHaveValue(
      "2",
    );
    await f.submit("Выдать материалы");
    for (const stage of ["0", "1"]) {
      form = await f.click("Этап и брак");
      await form.getByLabel("Этап", { exact: true }).selectOption(stage);
      await f.submit("Этап и брак");
    }
    form = await f.click("Подтвердить выпуск");
    await form.getByLabel("Код партии", { exact: true }).fill("READY-01");
    await form.getByLabel("Годен до", { exact: true }).fill("2099-12-31");
    await f.submit("Подтвердить выпуск");
    await expect
      .poll(
        async () =>
          (await f.docs()).find((x) => x.kind === "production")?.state,
      )
      .toBe("completed");
    await expect(
      page
        .locator(".industry-detail")
        .getByText("Завершено · Версия 5", { exact: false }),
    ).toBeVisible();
    await f.capture();
  });
test("services: book, move, complete with materials and expose the separate payment order", async ({
  page,
}) => {
  const f = await setup(page, "services"),
    specialist = await f.resource("specialist"),
    place = await f.resource("workplace");
  await f.post(`${f.base}/stock-commands`, {
    key: key(),
    kind: "receipt",
    warehouseId: f.warehouse,
    itemId: f.material,
    quantity: "5",
    unit: "pc",
    unitCost: "2",
    note: "Материалы визита",
  });
  await f.open();
  let form = await f.click("Записать клиента");
  await form.getByLabel("Склад", { exact: true }).selectOption(f.warehouse);
  await form.getByLabel(/^Начало \(/).fill(`${past}T14:00`);
  await form.getByLabel(/^Конец \(/).fill(`${past}T15:00`);
  await form
    .getByLabel("Ресурсы: выберите специалиста и место", { exact: true })
    .selectOption([specialist, place]);
  await form
    .getByLabel("Клиент / учащийся", { exact: true })
    .selectOption(f.customer);
  await form
    .getByLabel("Услуга каталога", { exact: true })
    .selectOption(f.service);
  await form.getByLabel("Цена визита, ₸", { exact: true }).fill("100");
  await form.getByLabel("Материал 1", { exact: true }).selectOption(f.material);
  await f.submit("Записать клиента");
  await page
    .locator(".industry-card")
    .filter({ hasText: "Консультация" })
    .click();
  form = await f.click("Перенести");
  await form.getByLabel(/^Начало \(/).fill(`${past}T15:00`);
  await form.getByLabel(/^Конец \(/).fill(`${past}T16:00`);
  await form
    .getByLabel("Ресурсы: выберите специалиста и место", { exact: true })
    .selectOption([specialist, place]);
  await f.submit("Перенести");
  form = await f.click("Завершить запись");
  await form.getByLabel("Результат", { exact: true }).selectOption("completed");
  await f.submit("Завершить запись");
  await expect(
    page.getByText("Связанный заказ для оплаты в разделе «Финансы»", {
      exact: false,
    }),
  ).toBeVisible();
  await f.capture();
  await page.getByRole("button", { name: "РУС", exact: true }).click();
  const account = (
    await f.post(`${f.base}/finance/accounts`, {
      key: key(),
      branchId: f.branch,
      name: "Касса услуг",
      opening: "0",
    })
  ).id;
  const visit = (await f.docs()).find((x) => x.kind === "appointment")!;
  const orderId = (visit.data.orderIds as string[])[0];
  await page
    .getByRole("button", { name: "Открыть заказ и оплату", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Карточка заказа", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Денежная операция", exact: true })
    .click();
  const payment = page.getByRole("region", {
    name: "Форма операции",
    exact: true,
  });
  await payment
    .getByRole("combobox", { name: "Вид операции", exact: true })
    .selectOption("payment");
  await payment
    .getByRole("combobox", { name: "Денежный счёт", exact: true })
    .selectOption(account);
  await expect(
    payment.getByRole("combobox", { name: "Заказ", exact: true }),
  ).toHaveValue(orderId);
  await payment.getByLabel("Сумма, ₸", { exact: true }).fill("50");
  await payment
    .getByLabel("Основание", { exact: true })
    .fill("Частичная оплата визита");
  await payment.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(payment).not.toBeVisible();
  expect((await f.get(`${f.base}/finance/summary`)).receivable_minor).toBe(
    "5000",
  );
});
test("education: schedule a lesson and create attendance-based charges in the UI", async ({
  page,
}) => {
  const f = await setup(page, "education"),
    teacher = await f.resource("teacher"),
    room = await f.resource("room");
  const course = (
      await f.command({
        kind: "course",
        title: "Курс тест",
        serviceItemId: f.service,
        warehouseId: f.warehouse,
        lessonPrice: "20",
        lessons: 5,
      })
    ).id,
    group = (
      await f.command({
        kind: "group",
        title: "Группа тест",
        courseId: course,
        capacity: 5,
      })
    ).id;
  await f.command({
    kind: "enroll",
    groupId: group,
    customerId: f.customer,
    guardianId: null,
    endsOn: "2099-12-31",
    note: "Зачисление",
  });
  await f.open();
  let form = await f.click("Запланировать занятие");
  await form.getByLabel(/^Начало \(/).fill(`${past}T14:00`);
  await form.getByLabel(/^Конец \(/).fill(`${past}T15:00`);
  await form
    .getByLabel("Ресурсы: выберите специалиста и место", { exact: true })
    .selectOption([teacher, room]);
  await form.getByLabel("Группа", { exact: true }).selectOption(group);
  await f.submit("Запланировать занятие");
  await page.locator(".industry-card").filter({ hasText: "Запись" }).click();
  form = await f.click("Посещение и начисление");
  await expect(form.getByRole("checkbox")).toBeChecked();
  await f.submit("Посещение и начисление");
  await expect
    .poll(
      async () =>
        (await f.docs()).find((x) => x.kind === "enrollment")?.data.attended,
    )
    .toBe(1);
  await f.capture();
});
test("projects: proposal, team, time, acceptance and separate payment order", async ({
  page,
}) => {
  const f = await setup(page, "projects");
  const inquiry = (
    await f.post(`${f.base}/crm/inquiries`, {
      key: key(),
      branchId: f.branch,
      customerId: f.customer,
      source: "manual",
      externalId: "",
      title: "Проект тест",
      message: "Синтетическая заявка",
      responsibleId: null,
    })
  ).id;
  const quote = (
    await f.post(`${f.base}/crm/quotes`, {
      key: key(),
      inquiryId: inquiry,
      validUntil: "2099-12-31",
      terms: "Тестовые условия",
      note: "Предложение",
      lines: [
        {
          itemId: f.service,
          quantity: "1",
          unit: "pc",
          price: "100",
          discount: "0",
        },
      ],
    })
  ).id;
  await f.open();
  let form = await f.click("Создать проект");
  await form.getByLabel("Название", { exact: true }).fill("Проект браузер");
  await form.getByLabel("Склад", { exact: true }).selectOption(f.warehouse);
  await form.getByLabel("Предложение CRM", { exact: true }).selectOption(quote);
  await form.getByLabel("Бюджет затрат, ₸", { exact: true }).fill("50");
  await form
    .getByLabel("Команда", { exact: true })
    .selectOption(f.workspace.members[0].user_id);
  await form
    .getByLabel("Этапы, через запятую", { exact: true })
    .fill("Разработка");
  await f.submit("Создать проект");
  await page
    .locator(".industry-card")
    .filter({ hasText: "Проект браузер" })
    .click();
  form = await f.click("Учесть время");
  await form
    .getByLabel("Исполнитель", { exact: true })
    .selectOption(f.workspace.members[0].user_id);
  await form.getByLabel("Этап", { exact: true }).selectOption("0");
  await form.getByLabel("Ставка, ₸/час", { exact: true }).fill("10");
  await form.getByLabel("Дата работы", { exact: true }).fill(past);
  await f.submit("Учесть время");
  form = await f.click("Принять этап");
  await form.getByLabel("Этап", { exact: true }).selectOption("0");
  await f.submit("Принять этап");
  await f.click("Сдать проект");
  await f.submit("Сдать проект");
  await expect
    .poll(async () => (await f.docs()).find((x) => x.kind === "project")?.state)
    .toBe("completed");
  await f.capture();
});
const future = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
async function recipeAndPlan(
  page: Page,
  f: Awaited<ReturnType<typeof setup>>,
  title: string,
  stages: string,
) {
  await f.post(`${f.base}/stock-commands`, {
    key: key(),
    kind: "receipt",
    warehouseId: f.warehouse,
    itemId: f.material,
    quantity: "30",
    unit: "pc",
    unitCost: "2",
    note: "Сырьё",
  });
  await f.open();
  let form = await f.click("Рецептура / спецификация");
  await form.getByLabel("Название", { exact: true }).fill(title);
  await form
    .getByLabel("Готовый товар", { exact: true })
    .selectOption(f.product);
  await form.getByLabel("Выход в базовых единицах", { exact: true }).fill("10");
  await form.getByLabel("Материал 1", { exact: true }).selectOption(f.material);
  await form.getByLabel("Количество", { exact: true }).fill("15");
  await form.getByLabel("Этапы, через запятую", { exact: true }).fill(stages);
  await f.submit("Рецептура / спецификация");
  const recipe = (await f.docs()).find((x) => x.kind === "recipe")!;
  form = await f.click("План выпуска");
  await form.getByLabel("Склад", { exact: true }).selectOption(f.warehouse);
  await form
    .getByLabel("Рецептура / спецификация", { exact: true })
    .selectOption(recipe.id);
  await form.getByLabel("План выпуска", { exact: true }).fill("10");
  await f.submit("План выпуска");
  const plan = (await f.docs()).find((x) => x.kind === "production")!;
  await page
    .locator(".industry-card")
    .filter({ hasText: title })
    .filter({ hasNotText: "Рецептура" })
    .first()
    .click();
  await expect(page.getByText(/План \/ годный выпуск/)).toBeVisible();
  // Material requirements come from the recipe version (15 per 10 units).
  await f.click("Выдать материалы");
  await f.submit("Выдать материалы");
  return plan;
}
test("food: recipe, plan, material issue, stages, dated lot, sale and expiry write-off in RU/KK", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const f = await setup(page, "food");
  await recipeAndPlan(page, f, "Хлеб пшеничный", "Замес, Выпечка");
  for (const stage of ["Замес", "Выпечка"]) {
    const form = await f.click("Этап и брак");
    await form
      .getByLabel("Этап", { exact: true })
      .selectOption({ label: stage });
    await f.submit("Этап и брак");
  }
  let form = await f.click("Подтвердить выпуск");
  await form.getByLabel("Годный выпуск", { exact: true }).fill("10");
  await form.getByLabel("Безвозвратный брак", { exact: true }).fill("0");
  await form.getByLabel("Код партии", { exact: true }).fill("BREAD-E2E");
  await form.getByLabel("Годен до", { exact: true }).fill(future);
  await f.submit("Подтвердить выпуск");
  await expect(page.getByText(/10 \/ 10/)).toBeVisible();
  // Sale of 3 from the dated lot (FEFO), through the ordinary order services.
  const order = await f.post(`${f.base}/orders`, {
    key: key(),
    branchId: f.branch,
    customerId: f.customer,
    warehouseId: f.warehouse,
    dueDate: future,
    delivery: "pickup",
    note: "Продажа хлеба",
    taxMode: "excluded",
    lines: [
      {
        itemId: f.product,
        quantity: "3",
        unit: "pc",
        price: "100",
        discount: "0",
      },
    ],
  });
  await f.post(`${f.base}/orders/${order.id}/commands`, {
    key: key(),
    version: 1,
    kind: "confirm",
    note: "Резерв",
  });
  const view = await f.get(`${f.base}/orders/${order.id}`);
  await f.post(`${f.base}/orders/${order.id}/commands`, {
    key: key(),
    version: view.order.version,
    kind: "fulfill",
    lineId: view.lines[0].id,
    quantity: "3",
    note: "Выдача",
  });
  // Remaining lot is written off with an explicit waste document (not an ordinary issue).
  await page
    .getByRole("button", { name: "Обновить", exact: true })
    .first()
    .click();
  form = await f.click("Списать партию");
  await form.getByLabel("Склад", { exact: true }).selectOption(f.warehouse);
  await form.getByLabel("Товар", { exact: true }).selectOption(f.product);
  await form
    .getByLabel("Количество в базовых единицах", { exact: true })
    .fill("7");
  const lot = await form
    .getByLabel("Партия", { exact: true })
    .locator("option", { hasText: "BREAD-E2E" })
    .getAttribute("value");
  await form.getByLabel("Партия", { exact: true }).selectOption(lot!);
  await f.submit("Списать партию");
  const balance = await f.get(
    `${f.base}/inventory/balances?warehouseId=${f.warehouse}`,
  );
  const bread = balance.items.find(
    (x: { item_id: string }) => x.item_id === f.product,
  );
  expect(Number(bread.quantity)).toBe(0);
  await f.capture();
});
test("production: specification, issue, defects and rework, good output with irreversible scrap in RU/KK", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const f = await setup(page, "production");
  await recipeAndPlan(page, f, "Стол", "Раскрой, Сборка");
  let form = await f.click("Этап и брак");
  await form
    .getByLabel("Этап", { exact: true })
    .selectOption({ label: "Раскрой" });
  await form.getByLabel("Выявлено брака, единиц", { exact: true }).fill("2");
  await form
    .getByLabel("Исправлено переделкой, единиц", { exact: true })
    .fill("1");
  await f.submit("Этап и брак");
  form = await f.click("Этап и брак");
  await form
    .getByLabel("Этап", { exact: true })
    .selectOption({ label: "Сборка" });
  await f.submit("Этап и брак");
  form = await f.click("Подтвердить выпуск");
  await form.getByLabel("Годный выпуск", { exact: true }).fill("9");
  await form.getByLabel("Безвозвратный брак", { exact: true }).fill("1");
  await form.getByLabel("Код партии", { exact: true }).fill("TABLE-E2E");
  await f.submit("Подтвердить выпуск");
  await expect(page.getByText(/10 \/ 9/)).toBeVisible();
  await expect(page.getByText(/2 \/ 1/)).toBeVisible();
  const balance = await f.get(
    `${f.base}/inventory/balances?warehouseId=${f.warehouse}`,
  );
  const table = balance.items.find(
    (x: { item_id: string }) => x.item_id === f.product,
  );
  expect(Number(table.quantity)).toBe(9);
  await f.capture();
});
