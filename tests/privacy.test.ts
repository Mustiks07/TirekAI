import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createMemoryDatabase,
  migrate,
  type Database,
} from "../src/server/db/database";
import { Platform } from "../src/server/platform";
import { InventoryService } from "../src/server/inventory/service";
import { CommerceService } from "../src/server/commerce/service";
import { CrmService } from "../src/server/crm/service";
import { IndustryService } from "../src/server/industry/service";
import { PrivacyService } from "../src/server/privacy/service";

// T053: erasure of personal data keeps accounting links, locks the subject and leaves no copy
// outside the accounting journal (which is retained by law and listed explicitly).
let db: Database,
  p: Platform,
  owner: string,
  manager: string,
  org: string,
  clinic: string,
  branch: string,
  clinicBranch: string,
  warehouse: string,
  item: string,
  account: string;
const key = () => randomUUID();
const NAME = "Гүлнар Синтетикова",
  EMAIL = "gulnar.synthetic@example.test",
  PHONE = "+77001234567";
const privacy = () => new PrivacyService(db);
beforeAll(async () => {
  db = await createMemoryDatabase();
  await migrate(db);
  p = new Platform(db);
  const user = () =>
    p.register({
      name: "Privacy",
      email: `${key()}@example.test`,
      password: "Synthetic-Privacy-661!",
    });
  owner = (await user()).token;
  org = (
    await p.createOrganization(owner, { name: "Privacy", profile: "retail" })
  ).id;
  branch = (await p.workspace(owner, org)).branches[0].id;
  const m = await user();
  const inv = await p.invite(owner, org, {
    email: m.user.email,
    role: "manager",
    branchId: branch,
  });
  await p.acceptInvitation(m.token, { token: inv.token });
  manager = m.token;
  const stock = new InventoryService(db);
  warehouse = (
    await stock.createWarehouse(owner, org, { branchId: branch, name: "Склад" })
  ).id;
  item = (
    await stock.saveItem(owner, org, {
      sku: "P-1",
      name_ru: "Товар",
      kind: "goods",
      base_unit: "pc",
      purchase_price: "10",
      sale_price: "20",
    })
  ).id!;
  await stock.execute(owner, org, {
    key: key(),
    kind: "receipt",
    warehouseId: warehouse,
    itemId: item,
    quantity: "5",
    unit: "pc",
    unitCost: "10",
    note: "Приход",
  });
  account = (
    await new CommerceService(db).createAccount(owner, org, {
      key: key(),
      branchId: branch,
      name: "Касса",
      opening: "0",
    })
  ).id;
  clinic = (
    await p.createOrganization(owner, {
      name: "Clinic privacy",
      profile: "clinic",
    })
  ).id;
  clinicBranch = (await p.workspace(owner, clinic)).branches[0].id;
});
afterAll(async () => {
  await db?.close();
});
async function occurrences(text: string) {
  const tables = (
    await db.query<{ t: string }>(
      "SELECT tablename t FROM pg_tables WHERE schemaname='public' ORDER BY 1",
    )
  ).map((r) => r.t);
  const found: string[] = [];
  for (const t of tables) {
    const [r] = await db.query<{ n: number }>(
      `SELECT count(*)::int n FROM "${t}" x WHERE x::text LIKE $1`,
      [`%${text}%`],
    );
    if (r.n) found.push(t);
  }
  return found;
}
it("T053: owner erases a customer; accounting stays linked, the record is locked and the data is gone elsewhere", async () => {
  const crm = new CrmService(db),
    commerce = new CommerceService(db);
  const customer = (
    await crm.createCustomer(owner, org, {
      key: key(),
      branchId: branch,
      name: NAME,
      email: EMAIL,
      phone: PHONE,
      kind: "person",
      responsibleId: null,
      consents: { email: true, sms: true, messenger: true },
      consentNote: `Согласие ${NAME} по телефону ${PHONE}`,
    })
  ).id;
  await crm.createInquiry(owner, org, {
    key: key(),
    branchId: branch,
    customerId: customer,
    source: "manual",
    externalId: "",
    title: `Звонок ${NAME}`,
    message: `Перезвонить на ${PHONE}, почта ${EMAIL}`,
    responsibleId: null,
  });
  const order = await commerce.create(owner, org, {
    key: key(),
    branchId: branch,
    customerId: customer,
    warehouseId: warehouse,
    dueDate: "2026-12-31",
    delivery: "pickup",
    note: "Заказ",
    taxMode: "excluded",
    lines: [
      { itemId: item, quantity: "1", unit: "pc", price: "20", discount: "0" },
    ],
  });
  await commerce.transition(owner, org, order.id, {
    key: key(),
    version: 1,
    kind: "confirm",
    note: "Резерв",
  });
  await commerce.money(owner, org, {
    key: key(),
    accountId: account,
    orderId: order.id,
    kind: "payment",
    amount: "20",
    note: "Оплата",
  });
  const summary = await commerce.summary(owner, org, {});
  expect((await occurrences(EMAIL)).length).toBeGreaterThan(0);
  const [{ version }] = await db.query<{ version: number }>(
    "SELECT version FROM customers WHERE id=$1",
    [customer],
  );
  await expect(
    privacy().eraseCustomer(manager, org, customer, {
      key: key(),
      version,
      reason: "subject_request",
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    privacy().eraseCustomer(owner, org, customer, {
      key: key(),
      version: version + 5,
      reason: "subject_request",
    }),
  ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  const k = key();
  const r = await privacy().eraseCustomer(owner, org, customer, {
    key: k,
    version,
    reason: "subject_request",
  });
  expect(r.counts).toMatchObject({ customer: 1, inquiries: 1 });
  expect(r.counts.crmNotes).toBeGreaterThanOrEqual(1);
  // Same key: same result, nothing repeated.
  expect(
    await privacy().eraseCustomer(owner, org, customer, {
      key: k,
      version,
      reason: "subject_request",
    }),
  ).toEqual({
    ...r,
    reused: true,
  });
  await expect(
    privacy().eraseCustomer(owner, org, customer, {
      key: key(),
      version: version + 1,
      reason: "subject_request",
    }),
  ).rejects.toMatchObject({ code: "SUBJECT_ERASED" });
  // Personal data remains only in the accounting journal (counterparty name of the payment).
  expect(await occurrences(EMAIL)).toEqual([]);
  expect(await occurrences(PHONE)).toEqual([]);
  expect(await occurrences(NAME)).toEqual(["money_entries"]);
  // Accounting is unchanged and still linked.
  expect(await commerce.summary(owner, org, {})).toEqual(summary);
  expect((await commerce.get(owner, org, order.id)).order.customer_id).toBe(
    customer,
  );
  // The subject is locked for changes and for new orders; history stays readable.
  await expect(
    crm.profile(owner, org, customer, {
      key: key(),
      version: version + 1,
      name: NAME,
      email: EMAIL,
      phone: PHONE,
      kind: "person",
      responsibleId: null,
      consents: { email: true, sms: false, messenger: false },
      consentNote: "Попытка восстановить",
    }),
  ).rejects.toMatchObject({ code: "SUBJECT_ERASED" });
  await expect(
    commerce.create(owner, org, {
      key: key(),
      branchId: branch,
      customerId: customer,
      warehouseId: warehouse,
      dueDate: "2026-12-31",
      delivery: "pickup",
      note: "Новый заказ",
      taxMode: "excluded",
      lines: [
        { itemId: item, quantity: "1", unit: "pc", price: "20", discount: "0" },
      ],
    }),
  ).rejects.toBeTruthy();
  expect(
    (await crm.history(owner, org, customer, {})).items.length,
  ).toBeGreaterThan(0);
  const audit = await db.query<{ details: Record<string, string> }>(
    "SELECT details FROM audit_events WHERE organization_id=$1 AND action='privacy.customer_erased'",
    [org],
  );
  expect(audit).toEqual([
    { details: { customerId: customer, reason: "subject_request" } },
  ]);
  expect((await privacy().requests(owner, org)).items).toHaveLength(1);
});
it("T053: a clinic request loses the patient's name and contact everywhere and stays locked", async () => {
  const stock = new InventoryService(db);
  const w = (
    await stock.createWarehouse(owner, clinic, {
      branchId: clinicBranch,
      name: "Кабинет",
    })
  ).id;
  const service = (
    await stock.saveItem(owner, clinic, {
      sku: "VISIT",
      name_ru: "Приём",
      kind: "service",
      base_unit: "pc",
      purchase_price: "10",
      sale_price: "100",
    })
  ).id!;
  const industry = new IndustryService(db);
  const PATIENT = "Пациент Синтетиков",
    CONTACT = "+77009998877";
  const id = (
    await industry.command(owner, clinic, {
      key: key(),
      kind: "clinic",
      branchId: clinicBranch,
      patientName: PATIENT,
      contact: CONTACT,
      serviceItemId: service,
      warehouseId: w,
      price: "100",
      note: `Записан ${PATIENT}`,
    })
  ).id;
  expect(await occurrences(CONTACT)).not.toEqual([]);
  const [{ version }] = await db.query<{ version: number }>(
    "SELECT version FROM industry_documents WHERE id=$1",
    [id],
  );
  await privacy().eraseClinicRequest(owner, clinic, id, {
    key: key(),
    version,
    reason: "subject_request",
  });
  expect(await occurrences(PATIENT)).toEqual([]);
  expect(await occurrences(CONTACT)).toEqual([]);
  // Readable, but no further command is accepted.
  expect((await industry.detail(owner, clinic, id)).document.title).toBe(
    "[удалено]",
  );
  await expect(
    industry.command(owner, clinic, {
      key: key(),
      kind: "clinic_invoice",
      id,
      version: version + 1,
      note: "Счёт",
    }),
  ).rejects.toMatchObject({ code: "SUBJECT_ERASED" });
});
