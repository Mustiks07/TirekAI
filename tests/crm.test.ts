import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import {
  createMemoryDatabase,
  migrate,
  type Database,
} from "../src/server/db/database";
import { Platform } from "../src/server/platform";
import { CrmService } from "../src/server/crm/service";
import { InventoryService } from "../src/server/inventory/service";
import { CommerceService } from "../src/server/commerce/service";
import { ImportService } from "../src/server/imports/service";
import { quotePdf } from "../src/server/crm/pdf";
import { extractDocument } from "../src/server/purchasing/extract";
import {
  crmCustomers,
  inquiriesView,
  quotesView,
  quoteRow,
  crmHistory,
} from "../src/domain/crm";
import { customersViewSchema } from "../src/domain/import-contracts";
let db: Database,
  p: Platform,
  s: CrmService,
  token: string,
  org: string,
  branch: string,
  customer: string,
  inquiry: string,
  quote: string,
  item: string,
  warehouse: string,
  outsider: string;
const key = () => randomUUID(),
  json = (v: unknown) => JSON.parse(JSON.stringify(v));
beforeAll(async () => {
  db = await createMemoryDatabase();
  await migrate(db);
  p = new Platform(db);
  s = new CrmService(db);
  const u = await p.register({
    name: "CRM Test",
    email: `${key()}@example.test`,
    password: "Synthetic-CRM-Password-661!",
  });
  token = u.token;
  org = (
    await p.createOrganization(token, { name: "CRM Lab", profile: "retail" })
  ).id;
  branch = (await p.workspace(token, org)).branches[0].id;
  outsider = (
    await p.register({
      name: "Outside CRM",
      email: `${key()}@example.test`,
      password: "Synthetic-CRM-Password-661!",
    })
  ).token;
  const inv = new InventoryService(db);
  item = (
    await inv.saveItem(token, org, {
      sku: "CRM-TEA",
      name_ru: "Чай и консультация",
      name_kk: "Шай және кеңес",
      kind: "goods",
      base_unit: "pc",
      purchase_price: "10",
      sale_price: "20",
    })
  ).id!;
  warehouse = (
    await inv.createWarehouse(token, org, {
      branchId: branch,
      name: "CRM warehouse",
    })
  ).id;
});
afterAll(async () => {
  await db?.close();
});
it("creates a manual customer without fabricated import provenance, defaults to explicit channel consents", async () => {
  const c = {
    key: key(),
    branchId: branch,
    name: "Әлия Тест",
    email: "aliya@example.test",
    phone: "",
    kind: "company",
    responsibleId: null,
    consents: { email: true, sms: false, messenger: false },
    consentNote: "Synthetic explicit email consent",
  };
  customer = (await s.createCustomer(token, org, c)).id;
  expect((await s.createCustomer(token, org, c)).reused).toBe(true);
  const list = crmCustomers.parse(json(await s.customers(token, org, {})));
  expect(list.items[0]).toMatchObject({
    id: customer,
    kind: "company",
    consents: c.consents,
  });
  const legacy = customersViewSchema.parse(
    json(await new ImportService(db).customers(token, org, {})),
  );
  expect(legacy.items[0].source_file).toBeNull();
  expect(legacy.items[0].source_row).toBeNull();
  await expect(
    s.createCustomer(token, org, { ...c, key: key(), responsibleId: key() }),
  ).rejects.toMatchObject({ code: "RESPONSIBLE_SCOPE" });
});
it("deduplicates imported/test inquiries and preserves original message", async () => {
  const c = {
    key: key(),
    branchId: branch,
    customerId: customer,
    source: "test_incoming",
    externalId: "message-1",
    title: "Запрос на чай",
    message: "Нужны 3 упаковки, уточните цену",
    responsibleId: null,
  };
  inquiry = (await s.createInquiry(token, org, c)).id;
  expect((await s.createInquiry(token, org, c)).reused).toBe(true);
  await expect(
    s.createInquiry(token, org, { ...c, key: key() }),
  ).rejects.toMatchObject({ code: "DUPLICATE_INQUIRY" });
  const list = inquiriesView.parse(json(await s.inquiries(token, org, {})));
  expect(list.items[0].message).toBe(c.message);
});
it("requires closure reason and keeps won inquiries independent from money and fulfillment", async () => {
  await expect(
    s.transition(token, org, inquiry, {
      key: key(),
      version: 1,
      stageId: "won",
      note: "",
    }),
  ).rejects.toThrow();
  await s.transition(token, org, inquiry, {
    key: key(),
    version: 1,
    stageId: "won",
    note: "Клиент согласовал условия",
  });
  expect(
    (await new CommerceService(db).list(token, org, {})).items,
  ).toHaveLength(0);
  const pipeline = await s.pipeline(token, org);
  await expect(
    s.savePipeline(token, org, {
      version: pipeline.version,
      stages: pipeline.stages
        .filter((x) => x.id !== "won")
        .concat({
          id: "success",
          name_ru: "Успешно",
          name_kk: "Сәтті",
          terminal: "won",
        }),
    }),
  ).rejects.toMatchObject({ code: "STAGE_IN_USE" });
});
it("versions quote snapshots, exports real bilingual PDF and keeps corrections in customer history", async () => {
  const c = {
    key: key(),
    inquiryId: inquiry,
    validUntil: "2099-12-31",
    terms: "Доставка по согласованию. Жеткізу келісім бойынша.",
    lines: [
      { itemId: item, quantity: "3", unit: "pc", price: "20", discount: "10" },
    ],
    note: "Первое предложение",
  };
  quote = (await s.saveQuote(token, org, c)).id;
  let q = quoteRow.parse(json(await s.quote(token, org, quote)));
  expect(q.data.total_minor).toBe("5400");
  await s.saveQuote(
    token,
    org,
    {
      key: key(),
      version: 1,
      validUntil: c.validUntil,
      terms: c.terms,
      lines: [{ ...c.lines[0], discount: "0" }],
      note: "Скидка снята по согласованию",
    },
    quote,
  );
  q = quoteRow.parse(json(await s.quote(token, org, quote)));
  expect(q.version).toBe(2);
  expect(q.data.total_minor).toBe("6000");
  const pdf = await quotePdf(q, "kk");
  expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  await mkdir(".data", { recursive: true });
  await writeFile(".data/quote-test-kk.pdf", pdf);
  const extracted = await extractDocument("quote.pdf", pdf);
  expect(extracted.text).toContain("Шай");
  expect(extracted.text).toContain("60,00");
  expect(
    crmHistory
      .parse(json(await s.history(token, org, customer, {})))
      .items.filter((e) => e.kind === "quote.saved"),
  ).toHaveLength(2);
  expect(
    quotesView.safeParse(json(await s.quotes(token, org, {}))).success,
  ).toBe(true);
}, 30000);
it("converts a quote exactly once into a linked draft order without stock or payment", async () => {
  const c = {
    key: key(),
    version: 2,
    warehouseId: warehouse,
    dueDate: "2026-11-01",
    delivery: "pickup",
    note: "Клиент подтвердил предложение",
  };
  const r = await s.convert(token, org, quote, c);
  expect(await s.convert(token, org, quote, c)).toEqual({
    id: r.id,
    reused: true,
  });
  await expect(
    s.convert(token, org, quote, { ...c, key: key() }),
  ).rejects.toMatchObject({ code: "QUOTE_CONVERTED" });
  const o = await new CommerceService(db).get(token, org, r.id);
  expect(o.order).toMatchObject({
    quote_id: quote,
    inquiry_id: inquiry,
    state: "draft",
    paid_minor: "0",
    revenue_minor: "0",
    total_minor: "6000",
  });
  expect(
    await db.query(
      "SELECT id FROM stock_reservations WHERE organization_id=$1",
      [org],
    ),
  ).toHaveLength(0);
});
it("rejects outsiders from contacts, original inquiries, quote and PDF source", async () => {
  await expect(s.customers(outsider, org, {})).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(s.inquiries(outsider, org, {})).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(s.quote(outsider, org, quote)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(s.history(outsider, org, customer, {})).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
});
