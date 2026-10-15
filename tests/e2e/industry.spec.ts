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
