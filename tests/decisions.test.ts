import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createMemoryDatabase,
  migrate,
  type Database,
} from "../src/server/db/database";
import { Platform } from "../src/server/platform";
import { InventoryService } from "../src/server/inventory/service";
import { PurchasingService } from "../src/server/purchasing/service";
import { TaskService } from "../src/server/tasks/service";
import { InsightService } from "../src/server/decisions/insights";
import { ProposalService } from "../src/server/decisions/proposals";
import { TodayService } from "../src/server/decisions/today";
import {
  insightList,
  proposalDetail,
  todayView,
} from "../src/domain/decisions";
import { documentView } from "../src/domain/purchasing";

let db: Database,
  p: Platform,
  inv: InventoryService,
  pur: PurchasingService,
  tasks: TaskService,
  ins: InsightService,
  prop: ProposalService,
  org: string,
  branch: string,
  warehouse: string,
  supplier: string,
  owner: string,
  manager: string,
  managerMember: string,
  buyer: string,
  buyerId: string,
  buyer2: string,
  buyer2Id: string,
  employee: string;
const key = () => randomUUID();
const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Qyzylorda" }).format(
    new Date(),
  );
beforeAll(async () => {
  db = await createMemoryDatabase();
  await migrate(db);
  p = new Platform(db);
  inv = new InventoryService(db);
  pur = new PurchasingService(db);
  tasks = new TaskService(db);
  ins = new InsightService(db);
  prop = new ProposalService(db);
  const user = () =>
    p.register({
      name: `User ${key().slice(0, 4)}`,
      email: `${key()}@example.test`,
      password: "Synthetic-Decision-661!",
    });
  owner = (await user()).token;
  org = (
    await p.createOrganization(owner, {
      name: "Decision Lab",
      profile: "retail",
    })
  ).id;
  branch = (await p.workspace(owner, org)).branches[0].id;
  const join = async (role: string) => {
    const u = await user(),
      i = await p.invite(owner, org, {
        email: u.user.email,
        role,
        branchId: branch,
      });
    await p.acceptInvitation(u.token, { token: i.token });
    return u;
  };
  manager = (await join("manager")).token;
  managerMember = (await p.workspace(owner, org)).members.find(
    (m) => m.role === "manager",
  )!.id;
  const b = await join("purchasing");
  buyer = b.token;
  buyerId = b.user.id;
  const b2 = await join("purchasing");
  buyer2 = b2.token;
  buyer2Id = b2.user.id;
  employee = (await join("employee")).token;
  warehouse = (
    await inv.createWarehouse(owner, org, { branchId: branch, name: "Main" })
  ).id;
  supplier = (
    await pur.createSupplier(owner, org, {
      key: key(),
      name: "Supplier",
      contact: "test",
      paymentTerms: "On invoice",
      quality: 4,
      reliability: 4,
    })
  ).id;
});
afterAll(async () => {
  await db?.close();
});
async function lowStockItem(onHand: string) {
  const sku = (
    await inv.saveItem(owner, org, {
      sku: `TEA-${key().slice(0, 6)}`,
      name_ru: "Чай",
      kind: "goods",
      base_unit: "pc",
      purchase_price: "0",
      sale_price: "30",
    })
  ).id!;
  if (onHand !== "0")
    await inv.execute(owner, org, {
      key: key(),
      kind: "receipt",
      warehouseId: warehouse,
      itemId: sku,
      quantity: onHand,
      unit: "pc",
      unitCost: "10",
      note: "Opening stock",
    });
  await pur.createOffer(owner, org, {
    key: key(),
    supplierId: supplier,
    itemId: sku,
    supplierSku: "BOX-6",
    packQuantity: "6",
    baseUnit: "pc",
    packPrice: "60",
    minimumPacks: 1,
    delivery: "12",
    leadDays: 2,
    currency: "KZT",
    rate: null,
    rateDate: null,
    rateSource: "",
    tax: "included",
    taxPercent: null,
    dated: "2026-01-01",
    validUntil: "2030-12-31",
    characteristicsConfirmed: true,
    note: "Synthetic offer",
  });
  await ins.setReorderPoint(owner, org, {
    warehouseId: warehouse,
    itemId: sku,
    minimum: "10",
    safety: "2",
    leadDays: 2,
    version: 0,
  });
  await ins.detect(org);
  const list = insightList.parse(
    JSON.parse(
      JSON.stringify(await ins.list(buyer, org, { rule: "low_stock" })),
    ),
  );
  return { sku, insight: list.items.find((i) => i.entity_id === sku)! };
}
const detail = async (token: string, id: string) =>
  proposalDetail.parse(
    JSON.parse(JSON.stringify(await prop.get(token, org, id))),
  );
const cmd = async (
  token: string,
  id: string,
  body: Record<string, unknown>,
) => {
  const d = await detail(owner, id);
  return prop.command(token, org, id, {
    key: key(),
    version: d.proposal.version,
    ...body,
  });
};
it("T023/T024: low stock → evidence → draft purchase → approval → execution → task → receipt → verified effect", async () => {
  const { sku, insight } = await lowStockItem("3");
  expect(insight.evidence.facts).toMatchObject({
    available: "3",
    incoming: "0",
    shortage: "9",
    suggested_quantity: "12",
    suggested_total_minor: "13200",
  });
  expect(insight.evidence.sources.map((s) => s.type)).toEqual([
    "stock_balance",
    "supplier_offer",
  ]);
  // Finance-only or employee roles cannot see stock situations.
  expect((await ins.list(employee, org, {}).catch((e) => e)).code).toBe(
    "FORBIDDEN",
  );
  const id = (await prop.fromInsight(buyer, org, insight.id, { key: key() }))
    .id;
  let d = await detail(buyer, id);
  expect(d.proposal).toMatchObject({
    state: "draft",
    amount_minor: "13200",
    origin: "situation",
  });
  await prop.revise(buyer, org, id, {
    key: key(),
    version: d.proposal.version,
    params: {
      ...d.proposal.params,
      followUp: {
        assigneeId: buyerId,
        due: { date: "2030-01-01", time: "12:00" },
      },
    },
    note: "Назначить закупщика",
  });
  await cmd(buyer, id, { kind: "submit" });
  d = await detail(manager, id);
  expect(d.canApprove).toBe(true);
  await expect(
    cmd(buyer, id, { kind: "approve", paramVersion: 2, note: "Self" }),
  ).rejects.toMatchObject({ code: "SELF_APPROVAL" });
  await expect(
    cmd(manager, id, { kind: "approve", paramVersion: 1, note: "Old view" }),
  ).rejects.toMatchObject({ code: "PARAMS_CHANGED" });
  await cmd(manager, id, {
    kind: "approve",
    paramVersion: 2,
    note: "Согласовано",
  });
  const exec = {
    key: key(),
    version: (await detail(owner, id)).proposal.version,
    kind: "execute",
  };
  await prop.command(buyer, org, id, exec);
  expect((await prop.command(buyer, org, id, exec)).reused).toBe(true);
  await expect(cmd(buyer, id, { kind: "execute" })).rejects.toMatchObject({
    code: "PROPOSAL_STATE",
  });
  d = await detail(buyer, id);
  expect(d.proposal.state).toBe("executed");
  const po = d.proposal.result_id!;
  const order = await pur.get(buyer, org, po);
  expect(order.order).toMatchObject({
    state: "approved",
    total_minor: "13200",
  });
  expect(order.events.map((e) => String(e.kind)).sort()).toEqual([
    "approve",
    "created",
    "submit",
  ]);
  // The situation is now covered by an approved incoming purchase, but the effect is not yet verified.
  await ins.detect(org);
  expect((await ins.get(buyer, org, insight.id)).state).toBe("resolved");
  d = await detail(buyer, id);
  expect(d.proposal.outcome).toMatchObject({ status: "pending_effect" });
  const taskId = d.proposal.follow_up_task_id!;
  // Physical receipt through the normal purchasing flow.
  await pur.transition(buyer, org, po, {
    key: key(),
    version: 3,
    kind: "sent",
    note: "Sent manually",
  });
  const doc = (
    await pur.upload(buyer, org, {
      key: key(),
      orderId: po,
      filename: "invoice.csv",
      content: Buffer.from(`name,qty\nЧай,12\n${key()}`).toString("base64"),
      externalId: "",
    })
  ).id;
  await pur.review(owner, org, doc, {
    key: key(),
    version: 1,
    number: key(),
    date: today(),
    dueDate: today(),
    delivery: "12",
    total: "132",
    lines: [
      { itemId: sku, name: "Чай", unit: "pc", quantity: "12", unitPrice: "10" },
    ],
    note: "Checked",
    acknowledgeDiscrepancies: false,
  });
  const dv = documentView.parse(
    JSON.parse(JSON.stringify(await pur.document(owner, org, doc))),
  );
  await pur.receive(buyer, org, po, {
    key: key(),
    documentId: doc,
    version: 4,
    note: "All received",
    lines: [{ lineId: dv.lines[0].id, quantity: "12" }],
  });
  const t = async (
    token: string,
    kind: string,
    extra: Record<string, unknown> = {},
  ) =>
    tasks.command(token, org, taskId, {
      key: key(),
      version: (await tasks.get(owner, org, taskId)).task.version,
      kind,
      ...extra,
    });
  await t(buyer, "start");
  await t(buyer, "complete", {
    note: "Закупка принята",
    operation: { type: "purchase_order", id: po },
  });
  await t(manager, "verify", { note: "Проверено" });
  expect((await tasks.get(manager, org, taskId)).task.state).toBe("verified");
  await ins.detect(org);
  d = await detail(buyer, id);
  expect(d.proposal.outcome).toMatchObject({
    status: "effect_verified",
    available_now: "15.000000",
  });
  const view = todayView.parse(
    JSON.parse(JSON.stringify(await new TodayService(db).today(owner, org))),
  );
  expect(view.metrics).not.toBeNull();
  expect(view.sources[0]).toMatchObject({
    name: "internal",
    status: "available",
  });
});
it("T024: changing the amount after approval requires a new approval; revoked authority blocks execution", async () => {
  const { insight } = await lowStockItem("0");
  const id = (await prop.fromInsight(buyer, org, insight.id, { key: key() }))
    .id;
  await cmd(buyer, id, { kind: "submit" });
  await cmd(manager, id, {
    kind: "approve",
    paramVersion: 1,
    note: "Согласовано",
  });
  let d = await detail(buyer, id);
  const params = d.proposal.params as {
    lines: { offerId: string; quantity: string }[];
    budget: string;
  };
  await prop.revise(buyer, org, id, {
    key: key(),
    version: d.proposal.version,
    params: {
      ...params,
      budget: "1000",
      lines: [{ ...params.lines[0], quantity: "30" }],
    },
    note: "Больше товара",
  });
  d = await detail(buyer, id);
  expect(d.proposal).toMatchObject({
    state: "pending",
    param_version: 2,
    amount_minor: "31200",
  });
  await expect(cmd(buyer, id, { kind: "execute" })).rejects.toMatchObject({
    code: "PROPOSAL_STATE",
  });
  await cmd(manager, id, {
    kind: "approve",
    paramVersion: 2,
    note: "Новая сумма",
  });
  // The approving manager leaves the organization before execution.
  await p.removeMember(owner, org, managerMember);
  await expect(cmd(buyer, id, { kind: "execute" })).rejects.toMatchObject({
    code: "APPROVAL_REVOKED",
  });
  expect(
    await db.query(
      "SELECT id FROM purchase_orders WHERE organization_id=$1 AND note LIKE 'Нехватка%' AND total_minor=31200",
      [org],
    ),
  ).toHaveLength(0);
});
it("T024: limits and delegation bound approvals; business refusal is recorded as failure, not success", async () => {
  const { sku, insight } = await lowStockItem("1");
  await prop.setLimit(owner, org, {
    role: "manager",
    kind: "purchase_order",
    limit: "50",
  });
  const id = (await prop.fromInsight(buyer, org, insight.id, { key: key() }))
    .id;
  await cmd(buyer, id, { kind: "submit" });
  await expect(
    cmd(buyer2, id, { kind: "approve", paramVersion: 1, note: "No right" }),
  ).rejects.toMatchObject({ code: "APPROVAL_LIMIT" });
  const delegation = (
    await prop.delegate(owner, org, {
      key: key(),
      toUser: buyer2Id,
      kind: "purchase_order",
      maxAmount: "500",
      validUntil: new Date(Date.now() + 86400000).toISOString(),
    })
  ).id;
  await cmd(buyer2, id, {
    kind: "approve",
    paramVersion: 1,
    note: "По делегированию",
  });
  const d = await detail(owner, id);
  expect(d.approvals[0]).toMatchObject({ delegated: true });
  await prop.revokeDelegation(owner, org, delegation);
  await expect(cmd(buyer, id, { kind: "execute" })).rejects.toMatchObject({
    code: "APPROVAL_REVOKED",
  });
  // Owner approves a fresh proposal; the item is archived before execution, so execution fails visibly.
  const id2 = (await prop.fromInsight(buyer, org, insight.id, { key: key() }))
    .id;
  await cmd(buyer, id2, { kind: "submit" });
  await cmd(owner, id2, { kind: "approve", paramVersion: 1, note: "Owner" });
  await db.query("UPDATE catalog_items SET active=false WHERE id=$1", [sku]);
  const before = await db.query(
    "SELECT id FROM purchase_orders WHERE organization_id=$1",
    [org],
  );
  await cmd(buyer, id2, { kind: "execute" });
  const failed = await detail(buyer, id2);
  expect(failed.proposal).toMatchObject({
    state: "failed",
    error_code: "ITEM_MISMATCH",
    result_id: null,
  });
  expect(
    await db.query("SELECT id FROM purchase_orders WHERE organization_id=$1", [
      org,
    ]),
  ).toEqual(before);
});
it("T054/AC 04: the shortage shows stock available in another warehouse, and a purchase over its budget is refused", async () => {
  const second = (
    await inv.createWarehouse(owner, org, {
      branchId: branch,
      name: `Second ${key().slice(0, 4)}`,
    })
  ).id;
  const { sku, insight } = await lowStockItem("3");
  // No situation change yet: the other warehouse is empty.
  expect(insight.evidence.facts.other_warehouses_available).toBe("0");
  await inv.execute(owner, org, {
    key: key(),
    kind: "receipt",
    warehouseId: second,
    itemId: sku,
    quantity: "20",
    unit: "pc",
    unitCost: "10",
    note: "Остаток на втором складе",
  });
  await ins.detect(org);
  const again = insightList
    .parse(
      JSON.parse(
        JSON.stringify(await ins.list(buyer, org, { rule: "low_stock" })),
      ),
    )
    .items.find((i) => i.entity_id === sku)!;
  expect(again.evidence.facts).toMatchObject({
    available: "3",
    other_warehouses_available: "20",
  });
  // Budget: the drafted purchase (132,00 KZT) cannot be revised to a budget below its amount.
  const id = (await prop.fromInsight(buyer, org, again.id, { key: key() })).id;
  const d = await detail(buyer, id);
  await expect(
    prop.revise(buyer, org, id, {
      key: key(),
      version: d.proposal.version,
      params: {
        ...(d.proposal.params as Record<string, unknown>),
        budget: "100",
      },
      note: "Бюджет меньше суммы",
    }),
  ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
});
