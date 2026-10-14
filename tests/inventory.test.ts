import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createMemoryDatabase,
  migrate,
  type Database,
} from "../src/server/db/database";
import { Platform } from "../src/server/platform";
import { InventoryService } from "../src/server/inventory/service";
import {
  toBase,
  allocatedValue,
  catalogSchema,
  stockViewSchema,
  inventoryContract,
} from "../src/domain/inventory";
const itemData = (sku: string) => ({
  sku,
  name_ru: "Сахар тест",
  name_kk: "Сынақ қанты",
  category: "Бакалея",
  kind: "goods",
  base_unit: "kg",
  conversions: [
    { unit: "bag", factor: "5" },
    { unit: "g", factor: "0.001" },
  ],
  purchase_price: "100",
  sale_price: "180",
});
describe("unit conversions and weighted cost", () => {
  it("converts exact fractions, rejects precision loss and unsupported units", () => {
    const item = {
      base_unit: "kg" as const,
      conversions: [{ unit: "g", factor: "0.001" }],
    };
    expect(toBase("125", "g", item)).toBe("0.125");
    expect(() => toBase("0.000001", "g", item)).toThrow("QUANTITY_PRECISION");
    expect(() => toBase("1", "box", item)).toThrow("UNIT_NOT_ALLOWED");
  });
  it("allocates rounded minor units and preserves the final remainder", () => {
    expect(allocatedValue(100n, "1", "3")).toBe(33n);
    expect(allocatedValue(67n, "1", "2")).toBe(34n);
    expect(allocatedValue(33n, "1", "1")).toBe(33n);
    expect(allocatedValue(999999999999999999999999999999n, "0.5", "1")).toBe(
      500000000000000000000000000000n,
    );
  });
  it("generates inventory request and response schemas", () => {
    expect(inventoryContract().schemas.Command).toBeDefined();
  });
});
let db: Database,
  p: Platform,
  s: InventoryService,
  owner: Awaited<ReturnType<Platform["register"]>>,
  seller: typeof owner,
  outsider: typeof owner,
  branchStaff: typeof owner;
let org: string,
  branch: string,
  warehouse: string,
  otherWarehouse: string,
  foreignWarehouse: string;
beforeAll(async () => {
  db = await createMemoryDatabase();
  await migrate(db);
  p = new Platform(db);
  s = new InventoryService(db);
  const account = () =>
    p.register({
      name: "Склад тест",
      email: `${randomUUID()}@example.test`,
      password: "Synthetic-Stock-Password-661!",
    });
  owner = await account();
  seller = await account();
  outsider = await account();
  branchStaff = await account();
  org = (
    await p.createOrganization(owner.token, {
      name: "Stock Test",
      profile: "retail",
    })
  ).id;
  branch = (await p.workspace(owner.token, org)).branches[0].id;
  warehouse = (
    await s.createWarehouse(owner.token, org, {
      branchId: branch,
      name: "Основной склад",
    })
  ).id;
  const branch2 = (
    await p.createBranch(owner.token, org, { name: "Другой филиал" })
  ).id;
  otherWarehouse = (
    await s.createWarehouse(owner.token, org, {
      branchId: branch2,
      name: "Другой склад",
    })
  ).id;
  for (const [person, role, branchId] of [
    [seller, "sales", null],
    [branchStaff, "manager", branch],
  ] as const) {
    const inv = await p.invite(owner.token, org, {
      email: person.user.email,
      role,
      branchId,
    });
    await p.acceptInvitation(person.token, { token: inv.token });
  }
  const otherOrg = (
    await p.createOrganization(outsider.token, {
      name: "Foreign stock",
      profile: "retail",
    })
  ).id;
  foreignWarehouse = (
    await s.createWarehouse(outsider.token, otherOrg, {
      branchId: (await p.workspace(outsider.token, otherOrg)).branches[0].id,
      name: "Foreign warehouse",
    })
  ).id;
});
afterAll(async () => {
  await db?.close();
});
const create = async () =>
  (await s.saveItem(owner.token, org, itemData(randomUUID())))!.id!;
const execute = (
  itemId: string,
  c: Record<string, unknown>,
  token = owner.token,
) =>
  s.execute(token, org, {
    key: randomUUID(),
    warehouseId: warehouse,
    itemId,
    note: "Тестовое основание",
    ...c,
  });
async function balance(itemId: string, wh = warehouse) {
  return (
    await db.query<{
      quantity: string;
      reserved: string;
      value: string;
      version: number;
    }>(
      "SELECT quantity::text,reserved::text,value_minor::text value,version FROM stock_balances WHERE organization_id=$1 AND item_id=$2 AND warehouse_id=$3",
      [org, itemId, wh],
    )
  )[0];
}
describe("catalogue and ledger", () => {
  it("stores bilingual variants and prices, enforces uniqueness and optimistic edits", async () => {
    const id = await create();
    const view = await s.catalog(owner.token, org);
    catalogSchema.parse(view);
    const i = view.items.find((v) => v.id === id)!;
    const { id: ignored, ...fields } = i;
    void ignored;
    await s.saveItem(owner.token, org, { ...fields, name_ru: "Новое имя" }, id);
    await expect(
      s.saveItem(owner.token, org, fields, id),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await expect(
      s.saveItem(owner.token, org, itemData(i.sku)),
    ).rejects.toMatchObject({ code: "ITEM_EXISTS" });
    expect(
      (await s.catalog(owner.token, org, { q: i.sku, limit: 1 })).items,
    ).toHaveLength(1);
  });
  it("does not expose costs to sales in catalogue, balances or movements", async () => {
    const id = await create();
    await execute(id, {
      kind: "receipt",
      quantity: "2",
      unit: "kg",
      unitCost: "100",
    });
    const catalog = await s.catalog(seller.token, org);
    expect(catalog.items.every((v) => !("purchase_price" in v))).toBe(true);
    for (const section of ["balances", "movements"] as const) {
      const result = await s.view(seller.token, org, section, {
        warehouseId: warehouse,
      });
      expect(result.items.every((v) => !("value_minor" in v))).toBe(true);
    }
    await expect(
      execute(
        id,
        { kind: "receipt", quantity: "1", unit: "kg", unitCost: "0" },
        seller.token,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("rejects foreign organization/warehouse access and branch-wide catalogue writes", async () => {
    const id = await create();
    await expect(s.catalog(outsider.token, org)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    for (const wh of [otherWarehouse, foreignWarehouse])
      await expect(
        s.view(branchStaff.token, org, "balances", { warehouseId: wh }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      s.saveItem(branchStaff.token, org, itemData("branch-write")),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      execute(id, {
        kind: "receipt",
        quantity: "1",
        unit: "kg",
        unitCost: "100",
        warehouseId: foreignWarehouse,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("receives converted units and issues weighted average cost with an immutable ledger", async () => {
    const id = await create();
    await execute(id, {
      kind: "receipt",
      quantity: "2",
      unit: "bag",
      unitCost: "500",
    });
    await execute(id, {
      kind: "receipt",
      quantity: "10",
      unit: "kg",
      unitCost: "200",
    });
    expect(await balance(id)).toMatchObject({
      quantity: "20.000000",
      value: "300000",
    });
    await execute(id, { kind: "issue", quantity: "4", unit: "kg" });
    expect(await balance(id)).toMatchObject({
      quantity: "16.000000",
      value: "240000",
    });
    const [sum] = await db.query<{ qty: string; value: string }>(
      "SELECT sum(quantity)::text qty,sum(value_minor)::text value FROM stock_movements WHERE item_id=$1",
      [id],
    );
    expect(sum).toEqual({ qty: "16.000000", value: "240000" });
    stockViewSchema.parse(
      await s.view(owner.token, org, "balances", { warehouseId: warehouse }),
    );
  });
  it("atomically deduplicates a repeated command and rejects key reuse with different data", async () => {
    const id = await create();
    const c = {
      kind: "receipt",
      key: randomUUID(),
      quantity: "2",
      unit: "kg",
      unitCost: "100",
    };
    const first = await execute(id, c),
      again = await execute(id, c);
    expect(again).toEqual({ ...first, reused: true });
    await expect(execute(id, { ...c, quantity: "3" })).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    expect((await balance(id)).quantity).toBe("2.000000");
  });
  it("rolls back rejected commands, forbids negative available stock and services", async () => {
    const id = await create();
    await expect(
      execute(id, { kind: "issue", quantity: "1", unit: "kg" }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    expect(await balance(id)).toBeUndefined();
    expect(
      await db.query("SELECT id FROM stock_commands WHERE item_id=$1", [id]),
    ).toHaveLength(0);
    const service = (await s.saveItem(owner.token, org, {
      ...itemData("service"),
      kind: "service",
      base_unit: "hour",
      conversions: [],
    }))!.id!;
    await expect(
      execute(service, {
        kind: "receipt",
        quantity: "1",
        unit: "hour",
        unitCost: "100",
      }),
    ).rejects.toMatchObject({ code: "SERVICE_NO_STOCK" });
  });
  it("allows exactly one reservation of the final unit and fulfils or releases it", async () => {
    const id = await create();
    await execute(id, {
      kind: "receipt",
      quantity: "1",
      unit: "kg",
      unitCost: "10",
    });
    const results = await Promise.allSettled([
      execute(id, { kind: "reserve", quantity: "1", unit: "kg" }, seller.token),
      execute(id, { kind: "reserve", quantity: "1", unit: "kg" }, seller.token),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const successful = results.find(
      (r) => r.status === "fulfilled",
    ) as PromiseFulfilledResult<{ id: string }>;
    expect((await balance(id)).reserved).toBe("1.000000");
    await expect(
      execute(id, { kind: "issue", quantity: "1", unit: "kg" }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    await execute(id, { kind: "release", reservationId: successful.value.id });
    const r = await execute(id, { kind: "reserve", quantity: "1", unit: "kg" });
    await execute(id, {
      kind: "issue",
      quantity: "1",
      unit: "kg",
      reservationId: r.id,
    });
    expect(await balance(id)).toMatchObject({
      quantity: "0.000000",
      reserved: "0.000000",
      value: "0",
    });
  });
  it("moves stock through transit without making it available at both warehouses", async () => {
    const id = await create();
    await execute(id, {
      kind: "receipt",
      quantity: "10",
      unit: "kg",
      unitCost: "100",
    });
    const transfer = await execute(id, {
      kind: "dispatch",
      quantity: "3",
      unit: "kg",
      destinationId: otherWarehouse,
    });
    expect((await balance(id)).quantity).toBe("7.000000");
    expect(await balance(id, otherWarehouse)).toBeUndefined();
    await expect(
      execute(
        id,
        {
          kind: "receive",
          transferId: transfer.id,
          warehouseId: otherWarehouse,
        },
        branchStaff.token,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const c = {
      kind: "receive",
      key: randomUUID(),
      transferId: transfer.id,
      warehouseId: otherWarehouse,
    };
    await execute(id, c);
    await execute(id, c);
    expect(await balance(id, otherWarehouse)).toMatchObject({
      quantity: "3.000000",
      value: "30000",
    });
    await expect(
      execute(id, { ...c, key: randomUUID() }),
    ).rejects.toMatchObject({ code: "TRANSFER_STATE" });
  });
  it("restores original issue cost on partial returns even after later receipts", async () => {
    const id = await create();
    await execute(id, {
      kind: "receipt",
      quantity: "3",
      unit: "kg",
      unitCost: "0.333333",
    });
    const issued = await execute(id, {
      kind: "issue",
      quantity: "3",
      unit: "kg",
    });
    await execute(id, {
      kind: "receipt",
      quantity: "1",
      unit: "kg",
      unitCost: "100",
    });
    for (let i = 0; i < 3; i++)
      await execute(id, {
        kind: "return",
        quantity: "1",
        unit: "kg",
        movementId: issued.id,
      });
    expect(await balance(id)).toMatchObject({
      quantity: "4.000000",
      value: "10100",
    });
    await expect(
      execute(id, {
        kind: "return",
        quantity: "1",
        unit: "kg",
        movementId: issued.id,
      }),
    ).rejects.toMatchObject({ code: "RETURN_EXCEEDS" });
  });
  it("records inventory discrepancy, requires a current version and preserves reservations", async () => {
    const id = await create();
    await execute(id, {
      kind: "receipt",
      quantity: "10",
      unit: "kg",
      unitCost: "100",
    });
    const b = await balance(id);
    await execute(id, {
      kind: "count",
      quantity: "8",
      unit: "kg",
      version: b.version,
    });
    expect(await balance(id)).toMatchObject({
      quantity: "8.000000",
      value: "80000",
    });
    await expect(
      execute(id, {
        kind: "count",
        quantity: "7",
        unit: "kg",
        version: b.version,
      }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await execute(id, { kind: "reserve", quantity: "8", unit: "kg" });
    await expect(
      execute(id, {
        kind: "count",
        quantity: "7",
        unit: "kg",
        version: (await balance(id)).version,
      }),
    ).rejects.toMatchObject({ code: "COUNT_BELOW_RESERVED" });
    await expect(
      execute(id, {
        kind: "count",
        quantity: "9",
        unit: "kg",
        version: (await balance(id)).version,
      }),
    ).rejects.toMatchObject({ code: "COUNT_COST_REQUIRED" });
    await execute(id, {
      kind: "count",
      quantity: "9",
      unit: "kg",
      unitCost: "110",
      version: (await balance(id)).version,
    });
    expect((await balance(id)).value).toBe("91000");
  });
  it("locks unit definitions once used and allows archival with closing operations", async () => {
    const id = await create();
    await execute(id, {
      kind: "receipt",
      quantity: "1",
      unit: "kg",
      unitCost: "10",
    });
    const i = (await s.catalog(owner.token, org, { limit: 100 })).items.find(
      (v) => v.id === id,
    )!;
    const { id: ignore, ...fields } = i;
    void ignore;
    await expect(
      s.saveItem(owner.token, org, { ...fields, base_unit: "pc" }, id),
    ).rejects.toMatchObject({ code: "UNIT_LOCKED" });
    const issued = await execute(id, {
      kind: "issue",
      quantity: "1",
      unit: "kg",
    });
    await s.saveItem(owner.token, org, { ...fields, active: false }, id);
    await expect(
      execute(id, {
        kind: "receipt",
        quantity: "1",
        unit: "kg",
        unitCost: "10",
      }),
    ).rejects.toMatchObject({ code: "ITEM_ARCHIVED" });
    await execute(id, {
      kind: "return",
      quantity: "1",
      unit: "kg",
      movementId: issued.id,
    });
    expect((await balance(id)).quantity).toBe("1.000000");
  });
  it("rejects commands attempting to inject time or a foreign item", async () => {
    const id = await create();
    await expect(
      execute(id, {
        kind: "receipt",
        quantity: "1",
        unit: "kg",
        unitCost: "10",
        created_at: "2020-01-01",
      }),
    ).rejects.toBeDefined();
    await expect(
      execute(randomUUID(), {
        kind: "receipt",
        quantity: "1",
        unit: "kg",
        unitCost: "10",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
