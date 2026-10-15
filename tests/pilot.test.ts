import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createMemoryDatabase, migrate } from "../src/server/db/database";
import { Platform } from "../src/server/platform";
import { InventoryService } from "../src/server/inventory/service";
import { CommerceService } from "../src/server/commerce/service";
import { CrmService } from "../src/server/crm/service";
import { comparePilot, pilotMetrics } from "../src/server/ops/pilot";

// T058: pilot metrics come from operations; unknown cost stays unknown; the comparison lists its limits.
it("T058: baseline and pilot metrics from operations, with explicit comparison limits", async () => {
  const db = await createMemoryDatabase();
  try {
    await migrate(db);
    const p = new Platform(db);
    const u = await p.register({
      name: "Pilot",
      email: `${randomUUID()}@example.test`,
      password: "Synthetic-Pilot-661!",
    });
    const t = u.token;
    const org = (
      await p.createOrganization(t, { name: "Pilot", profile: "retail" })
    ).id;
    const branch = (await p.workspace(t, org)).branches[0].id;
    const inv = new InventoryService(db),
      commerce = new CommerceService(db);
    const warehouse = (
      await inv.createWarehouse(t, org, { branchId: branch, name: "Склад" })
    ).id;
    const goods = (
      await inv.saveItem(t, org, {
        sku: "G",
        name_ru: "Товар",
        kind: "goods",
        base_unit: "pc",
        purchase_price: "60",
        sale_price: "100",
      })
    ).id!;
    const service = (
      await inv.saveItem(t, org, {
        sku: "S",
        name_ru: "Услуга",
        kind: "service",
        base_unit: "hour",
        purchase_price: null,
        sale_price: "50",
      })
    ).id!;
    await inv.execute(t, org, {
      key: randomUUID(),
      kind: "receipt",
      warehouseId: warehouse,
      itemId: goods,
      quantity: "10",
      unit: "pc",
      unitCost: "60",
      note: "Приход",
    });
    const customer = (
      await new CrmService(db).createCustomer(t, org, {
        key: randomUUID(),
        branchId: branch,
        name: "Клиент",
        email: "",
        phone: "",
        kind: "person",
        responsibleId: null,
        consents: { email: false, sms: false, messenger: false },
        consentNote: "Синтетика",
      })
    ).id;
    const sell = async (itemId: string, unit: string) => {
      const o = await commerce.create(t, org, {
        key: randomUUID(),
        branchId: branch,
        customerId: customer,
        warehouseId: warehouse,
        dueDate: "2026-12-31",
        delivery: "pickup",
        note: "Продажа",
        taxMode: "excluded",
        lines: [{ itemId, quantity: "2", unit, price: "100", discount: "0" }],
      });
      await commerce.transition(t, org, o.id, {
        key: randomUUID(),
        version: 1,
        kind: "confirm",
        note: "Резерв",
      });
      const v = await commerce.get(t, org, o.id);
      await commerce.transition(t, org, o.id, {
        key: randomUUID(),
        version: v.order.version,
        kind: "fulfill",
        lineId: v.lines[0].id,
        quantity: "2",
        note: "Выдача",
      });
    };
    await sell(goods, "pc");
    const [{ today }] = await db.query<{ today: string }>(
      "SELECT (now() AT TIME ZONE timezone)::date::text today FROM organizations WHERE id=$1",
      [org],
    );
    const known = await db.transaction((tx) =>
      pilotMetrics(tx, org, { from: today, to: today }),
    );
    expect(known.sales).toMatchObject({
      ordersFulfilled: 1,
      revenueMinor: "20000",
      costMinor: "12000",
      grossProfitMinor: "8000",
      eventsWithUnknownCost: 0,
    });
    // A service without a known cost: profit becomes unknown, not inflated.
    await sell(service, "hour");
    const pilot = await db.transaction((tx) =>
      pilotMetrics(tx, org, { from: today, to: today }),
    );
    expect(pilot.sales).toMatchObject({
      ordersFulfilled: 2,
      revenueMinor: "40000",
      costMinor: null,
      grossProfitMinor: null,
      eventsWithUnknownCost: 1,
    });
    const baseline = await db.transaction((tx) =>
      pilotMetrics(tx, org, { from: "2026-01-01", to: "2026-01-01" }),
    );
    expect(baseline.sales.ordersFulfilled).toBe(0);
    const c = comparePilot(baseline, pilot);
    expect(c.difference).toMatchObject({
      revenueMinor: "40000",
      grossProfitMinor: null,
      ordersFulfilled: 2,
    });
    expect(c.caveats).toEqual(
      expect.arrayContaining([
        "not_causal",
        "seasonality_not_adjusted",
        "unknown_costs",
        "small_sample",
      ]),
    );
    await expect(
      db.transaction((tx) =>
        pilotMetrics(tx, org, { from: "2026-02-01", to: "2026-01-01" }),
      ),
    ).rejects.toThrow();
  } finally {
    await db.close();
  }
});
