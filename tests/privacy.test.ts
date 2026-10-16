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
import { ImportService } from "../src/server/imports/service";
import { ImportWorker } from "../src/server/jobs/worker";
import { batchViewSchema } from "../src/domain/import-contracts";
import { ownerExport } from "../src/server/ops/export";
import { AssistantService } from "../src/server/assistant/service";

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
    new ImportService(db).updateCustomer(owner, org, customer, {
      version: version + 1,
      name: NAME,
      email: EMAIL,
      phone: PHONE,
    }),
  ).rejects.toMatchObject({ code: "SUBJECT_ERASED" });
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
it("T053: source CSV, duplicates and queued previews are erased; history and other customers survive", async () => {
  const imports = new ImportService(db),
    worker = new ImportWorker(db);
  await worker.runOnce();
  const header = "external_id,name,email,phone\n";
  const subject = "erase-csv,Ержан Тест,erase-csv@example.test,+77001112233\n";
  const other = "keep-csv,Другой Клиент,keep-csv@example.test,+77001112234\n";
  const upload = (content: string) =>
    imports.upload(owner, org, {
      branchId: branch,
      filename: "synthetic.csv",
      delimiter: ",",
      content,
    });
  // Both previews exist before the customer is imported; the second may already be queued.
  const first = await upload(header + subject + other);
  const queued = await upload(header + subject);
  await imports.confirm(owner, org, first.batch.id, {
    version: first.batch.version,
  });
  await worker.runOnce();
  await imports.confirm(owner, org, queued.batch.id, {
    version: queued.batch.version,
  });
  const duplicate = await upload(header + subject + subject);
  const [customer] = await db.query<{ id: string; version: number }>(
    "SELECT id,version FROM customers WHERE organization_id=$1 AND external_id='erase-csv'",
    [org],
  );
  const erased = await privacy().eraseCustomer(owner, org, customer.id, {
    key: key(),
    version: customer.version,
    reason: "subject_request",
  });
  expect(erased.counts).toMatchObject({ importSources: 3, importRows: 4 });
  await worker.runOnce();
  for (const batch of [first, queued, duplicate]) {
    const view = batchViewSchema.parse(
      JSON.parse(JSON.stringify(await imports.get(owner, org, batch.batch.id))),
    );
    expect(view.rows[0].values).toEqual({
      external_id: "",
      name: "",
      email: "",
      phone: "",
    });
    expect(view.rows[0].errors).toEqual(["SUBJECT_ERASED"]);
    const [raw] = await db.query<{ source_content: string }>(
      "SELECT source_content FROM import_batches WHERE id=$1",
      [batch.batch.id],
    );
    expect(raw.source_content).toBe("");
  }
  expect(
    (await imports.get(owner, org, first.batch.id)).rows[1].values.email,
  ).toBe("keep-csv@example.test");
  expect(await occurrences("erase-csv@example.test")).toEqual([]);
  expect(JSON.stringify(await ownerExport(db, owner, org))).not.toContain(
    "erase-csv@example.test",
  );
  // Same file remains deduplicated; a different file cannot recreate the erased external ID.
  expect((await upload(header + subject + other)).reused).toBe(true);
  const reimport = await upload(
    header + subject.replace("Ержан Тест", "Новое Имя"),
  );
  expect(reimport.rows[0]).toMatchObject({
    status: "invalid",
    errors: ["SUBJECT_ERASED"],
    values: { email: "" },
  });
  expect(
    await db.query(
      "SELECT id FROM customers WHERE organization_id=$1 AND external_id='erase-csv'",
      [org],
    ),
  ).toHaveLength(0);
});
it("T053: owner export respects the private assistant conversation boundary", async () => {
  const assistant = new AssistantService(db, null);
  const answer = await assistant.ask(manager, org, {
    key: key(),
    locale: "ru",
    text: "PRIVATE_EXPORT_REGRESSION",
  });
  await expect(
    assistant.conversation(owner, org, answer.conversationId),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  const exported = await ownerExport(db, owner, org);
  expect(exported.tables).not.toHaveProperty("assistant_messages");
  expect(exported.tables).not.toHaveProperty("assistant_conversations");
  expect(JSON.stringify(exported)).not.toContain("PRIVATE_EXPORT_REGRESSION");
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
