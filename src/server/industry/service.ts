import { PurchasingService } from "../purchasing/service";
import { purchaseQuantities } from "../purchasing/quantities";
import { CrmService } from "../crm/service";
import type { Construction, Clinic } from "../../domain/extended-industry";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database, Sql } from "../db/database";
import { sessionAccess, audit, type Credential } from "../access";
import { AppError } from "../../domain/errors";
import {
  industryCommand,
  industryKinds,
  type IndustryCommand,
} from "../../domain/industry";
import { idempotent, organizationClock } from "../execution/core";
import { InventoryService } from "../inventory/service";
import { CommerceService } from "../commerce/service";
import { TelegramService } from "../integrations/telegram-service";
import { connectionFor } from "../integrations/common";
import { D } from "../../domain/purchasing";
import { toBase, allocatedValue, type Item } from "../../domain/inventory";
import { lineAmount, minorUnits } from "../../domain/decimal";
import { stableUuid } from "../tasks/service";
import { TaskService } from "../tasks/service";
import type {
  Recipe,
  Production,
  Resource,
  Appointment,
  Course,
  Group,
  Enrollment,
  Project,
  Material,
} from "./types";
type Kind = (typeof industryKinds)[number];
type Doc<T = unknown> = {
  id: string;
  branch_id: string;
  kind: Kind;
  title: string;
  state: string;
  version: number;
  data: T;
  created_at: string;
  updated_at: string;
};
type Scope = { org: string; branch: string; actor: string; secret: Credential };
const columns =
  "id,branch_id,kind,title,state,version,data,created_at::text,updated_at::text";
const kzt = (n: string | bigint) => new D(n.toString()).div(100).toFixed(2);
const unique = (values: string[]) => {
  if (new Set(values).size !== values.length)
    throw new AppError("DUPLICATE_LINE", 422);
};
const exact = (n: InstanceType<typeof D>) => {
  if (n.decimalPlaces() > 6 || n.gte("1000000000000000") || n.lt(0))
    throw new AppError("QUANTITY_PRECISION", 422);
  return n.toFixed();
};
export class IndustryService {
  constructor(private db: Database) {}
  private async load<T>(
    tx: Sql,
    org: string,
    id: string,
    kind?: Kind,
  ): Promise<Doc<T>> {
    z.uuid().parse(id);
    const [d] = await tx.query<Doc<T>>(
      `SELECT ${columns} FROM industry_documents WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
      [org, id],
    );
    if (!d || (kind && d.kind !== kind)) throw new AppError("NOT_FOUND", 404);
    return d;
  }
  private async history(
    tx: Sql,
    s: Scope,
    d: Doc<unknown>,
    action: string,
    note: string,
  ) {
    await tx.query(
      "INSERT INTO industry_history(id,organization_id,document_id,version,action,data,note,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        randomUUID(),
        s.org,
        d.id,
        d.version,
        action,
        JSON.stringify(d.data),
        note,
        s.actor,
      ],
    );
    await audit(tx, s.org, s.actor, `industry.${action}`, s.branch, {
      documentId: d.id,
    });
  }
  private async create<T>(
    tx: Sql,
    s: Scope,
    id: string,
    kind: Kind,
    title: string,
    data: T,
    state = "active",
    note = "Создание / Құру",
  ) {
    await tx.query(
      "INSERT INTO industry_documents(id,organization_id,branch_id,kind,title,state,data,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [id, s.org, s.branch, kind, title, state, JSON.stringify(data), s.actor],
    );
    const d = await this.load<T>(tx, s.org, id);
    await this.history(tx, s, d, `${kind}.created`, note);
    return d;
  }
  private async save<T>(
    tx: Sql,
    s: Scope,
    d: Doc<T>,
    action: string,
    note: string,
    state = d.state,
  ) {
    await tx.query(
      "UPDATE industry_documents SET data=$3,state=$4,title=$5,version=version+1,updated_at=now() WHERE organization_id=$1 AND id=$2",
      [s.org, d.id, JSON.stringify(d.data), state, d.title],
    );
    d.version++;
    d.state = state;
    await this.history(tx, s, d, action, note);
  }
  private async item(
    tx: Sql,
    s: Scope,
    id: string,
    kind?: "goods" | "service",
  ) {
    const [i] = await tx.query<Item>(
      "SELECT id,sku,name_ru,name_kk,category,variant,barcode,kind,base_unit,conversions,purchase_price::text,sale_price::text,active,version FROM catalog_items WHERE organization_id=$1 AND id=$2 FOR SHARE",
      [s.org, id],
    );
    if (!i || !i.active || (kind && i.kind !== kind))
      throw new AppError("ITEM_MISMATCH", 422);
    return i;
  }
  private async items(tx: Sql, s: Scope, id: string, ids: string[]) {
    for (const item of new Set(ids))
      await tx.query(
        "INSERT INTO industry_item_links(organization_id,document_id,item_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [s.org, id, item],
      );
  }
  private async warehouse(tx: Sql, s: Scope, id: string) {
    if (
      !(
        await tx.query(
          "SELECT id FROM warehouses WHERE organization_id=$1 AND branch_id=$2 AND id=$3",
          [s.org, s.branch, id],
        )
      ).length
    )
      throw new AppError("WAREHOUSE_SCOPE", 403);
  }
  private async customer(tx: Sql, s: Scope, id: string) {
    if (
      !(
        await tx.query(
          "SELECT id FROM customers WHERE organization_id=$1 AND branch_id=$2 AND id=$3",
          [s.org, s.branch, id],
        )
      ).length
    )
      throw new AppError("CUSTOMER_SCOPE", 403);
  }
  private async materials(tx: Sql, s: Scope, materials: Material[]) {
    unique(materials.map((m) => m.itemId));
    return Promise.all(
      materials.map(async (m) => {
        const item = await this.item(tx, s, m.itemId, "goods");
        return {
          ...m,
          quantity: toBase(m.quantity, m.unit, item),
          unit: item.base_unit,
        };
      }),
    );
  }
  async list(secret: Credential, org: string, input: unknown) {
    const q = z
      .object({
        branchId: z.uuid().optional(),
        kind: z.enum(industryKinds).optional(),
      })
      .strict()
      .parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(
        tx,
        secret,
        org,
        "industry:read",
        q.branchId,
      );
      const [o] = await tx.query<{ profile: string; timezone: string }>(
        "SELECT profile,timezone FROM organizations WHERE id=$1",
        [org],
      );
      return {
        ...o,
        lots: await tx.query(
          "SELECT l.id,l.code,l.item_id,l.warehouse_id,l.quantity::text,l.expires_on::text FROM stock_lots l JOIN warehouses w ON w.organization_id=l.organization_id AND w.id=l.warehouse_id WHERE l.organization_id=$1 AND ($2::uuid IS NULL OR w.branch_id=$2) ORDER BY l.created_at DESC LIMIT 200",
          [org, s.branchId],
        ),
        items: await tx.query(
          `SELECT ${columns} FROM industry_documents WHERE organization_id=$1 AND ($2::uuid IS NULL OR branch_id=$2) AND ($3::text IS NULL OR kind=$3) ORDER BY created_at DESC,id LIMIT 200`,
          [org, s.branchId, q.kind ?? null],
        ),
      };
    });
  }
  async detail(secret: Credential, org: string, id: string) {
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "industry:read");
      const d = await this.load(tx, org, id);
      if (s.branchId && s.branchId !== d.branch_id)
        throw new AppError("FORBIDDEN", 403);
      return {
        document: d,
        history: await tx.query(
          "SELECT version,action,note,actor_id,created_at::text,data FROM industry_history WHERE organization_id=$1 AND document_id=$2 ORDER BY version DESC LIMIT 100",
          [org, id],
        ),
        lots: await tx.query(
          "SELECT l.id,l.code,l.item_id,l.warehouse_id,l.quantity::text,l.expires_on::text FROM stock_lots l JOIN warehouses w ON w.organization_id=l.organization_id AND w.id=l.warehouse_id WHERE l.organization_id=$1 AND w.branch_id=$2 ORDER BY l.created_at DESC LIMIT 200",
          [org, d.branch_id],
        ),
      };
    });
  }
  async command(secret: Credential, org: string, input: unknown) {
    const c = industryCommand.parse(input);
    return this.db.transaction(async (tx) => {
      const access = await sessionAccess(
        tx,
        secret,
        org,
        "industry:write",
        "branchId" in c ? c.branchId : undefined,
      );
      // Short, network-free commands serialize the organization's industry documents. Resource
      // rows are additionally locked in UUID order; this also covers different document IDs.
      const [o] = await tx.query<{ profile: string }>(
        "SELECT profile FROM organizations WHERE id=$1 FOR UPDATE",
        [org],
      );
      const existing =
        "id" in c && c.id ? await this.load(tx, org, c.id) : null;
      const branch = "branchId" in c ? c.branchId : existing!.branch_id;
      if (existing && existing.branch_id !== branch)
        throw new AppError("FORBIDDEN", 403);
      await sessionAccess(tx, secret, org, "industry:write", branch);
      const s: Scope = { org, branch, actor: access.actorId, secret };
      const r = await idempotent(tx, org, c.key, {
        operation: "industry",
        ...c,
      });
      if (r.reused) return r;
      if (existing && (!("version" in c) || existing.version !== c.version))
        throw new AppError("VERSION_CONFLICT", 409);
      const mode =
        c.kind === "recipe"
          ? c.mode
          : existing?.kind === "recipe"
            ? (existing.data as Recipe).mode
            : null;
      if (
        ![
          "food",
          "services",
          "education",
          "projects",
          "production",
          "construction",
          "clinic",
        ].includes(o.profile)
      )
        throw new AppError("PROFILE_NOT_SUPPORTED", 409);
      const required = c.kind.startsWith("construction")
        ? ["construction"]
        : c.kind.startsWith("clinic")
          ? ["clinic"]
          : c.kind.startsWith("production") ||
              c.kind === "recipe" ||
              c.kind === "lot_receipt" ||
              c.kind === "waste"
            ? ["food", "production"]
            : [
                  "course",
                  "group",
                  "enroll",
                  "enrollment_change",
                  "lesson",
                  "lesson_complete",
                ].includes(c.kind)
              ? ["education"]
              : [
                    "project",
                    "project_task",
                    "time",
                    "scope_change",
                    "scope_approve",
                    "project_stage",
                    "project_deliver",
                  ].includes(c.kind)
                ? ["projects"]
                : ["appointment", "appointment_end", "reminder"].includes(
                      c.kind,
                    )
                  ? ["services"]
                  : ["food", "services", "education", "production", "clinic"];
      if (!required.includes(o.profile) || (mode && mode !== o.profile))
        throw new AppError("PROFILE_NOT_SUPPORTED", 409);
      let id = existing?.id ?? r.id;
      await this.perform(tx, s, c, id, existing);
      if (c.kind === "lot_receipt") {
        const [movement] = await tx.query<{ id: string }>(
          "SELECT result->>'id' id FROM stock_commands WHERE organization_id=$1 AND request_key=$2",
          [org, c.key],
        );
        id = movement.id;
      }
      await tx.query(
        "UPDATE execution_commands SET result_id=$3 WHERE organization_id=$1 AND request_key=$2",
        [org, c.key, id],
      );
      return { id, reused: false };
    });
  }
  private async perform(
    tx: Sql,
    s: Scope,
    c: IndustryCommand,
    id: string,
    existing: Doc | null,
  ) {
    switch (c.kind) {
      case "recipe": {
        if (c.id && !existing) throw new AppError("NOT_FOUND", 404);
        if (existing && existing.kind !== "recipe")
          throw new AppError("NOT_FOUND", 404);
        await this.item(tx, s, c.outputItemId, "goods");
        unique(c.ingredients.map((x) => x.itemId));
        if (c.ingredients.some((x) => x.itemId === c.outputItemId))
          throw new AppError("RECIPE_CYCLE", 422);
        for (const x of c.ingredients)
          toBase(x.quantity, x.unit, await this.item(tx, s, x.itemId, "goods"));
        const data: Recipe = {
          mode: c.mode,
          outputItemId: c.outputItemId,
          outputQuantity: c.outputQuantity,
          ingredients: c.ingredients,
          stages: c.stages,
        };
        if (existing) {
          existing.data = data;
          existing.title = c.title;
          await this.save(tx, s, existing, "recipe.revised", c.note);
        } else
          await this.create(
            tx,
            s,
            id,
            "recipe",
            c.title,
            data,
            "active",
            c.note,
          );
        await this.items(tx, s, id, [
          c.outputItemId,
          ...c.ingredients.map((x) => x.itemId),
        ]);
        return;
      }
      case "lot_receipt": {
        await this.warehouse(tx, s, c.warehouseId);
        await new InventoryService(this.db).executeInTransaction(
          tx,
          s.secret,
          s.org,
          {
            key: c.key,
            kind: "receipt",
            warehouseId: c.warehouseId,
            itemId: c.itemId,
            quantity: c.quantity,
            unit: c.unit,
            unitCost: c.unitCost,
            lot: { code: c.lotCode, expiresOn: c.expiresOn },
            note: c.note,
          },
        );
        return;
      }
      case "production_plan": {
        await this.warehouse(tx, s, c.warehouseId);
        const recipe = await this.load<Recipe>(tx, s.org, c.recipeId, "recipe");
        this.sameBranch(s, recipe);
        const requirements = await this.materials(
          tx,
          s,
          recipe.data.ingredients.map((x) => ({
            ...x,
            quantity: new D(x.quantity)
              .times(c.quantity)
              .div(recipe.data.outputQuantity)
              .div(new D(1).minus(new D(x.lossPercent).div(100)))
              .toDecimalPlaces(6, D.ROUND_UP)
              .toFixed(),
          })),
        );
        if (c.salesOrderId) {
          const [order] = await tx.query(
            "SELECT id FROM sales_orders WHERE organization_id=$1 AND branch_id=$2 AND id=$3 AND state IN ('draft','confirmed','partial')",
            [s.org, s.branch, c.salesOrderId],
          );
          if (!order) throw new AppError("ORDER_STATE", 409);
          const [line] = await tx.query(
            "SELECT id FROM sales_order_lines WHERE organization_id=$1 AND order_id=$2 AND item_id=$3",
            [s.org, c.salesOrderId, recipe.data.outputItemId],
          );
          if (!line) throw new AppError("ITEM_MISMATCH", 422);
        }
        let plannedMaterialCostMinor: string | null = "0";
        for (const material of requirements) {
          const [balance] = await tx.query<{ quantity: string; value: string }>(
            "SELECT quantity::text,value_minor::text value FROM stock_balances WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3",
            [s.org, c.warehouseId, material.itemId],
          );
          if (!balance || new D(balance.quantity).lte(0)) {
            plannedMaterialCostMinor = null;
            break;
          }
          plannedMaterialCostMinor = (
            BigInt(plannedMaterialCostMinor!) +
            BigInt(
              new D(balance.value)
                .times(material.quantity)
                .div(balance.quantity)
                .toFixed(0),
            )
          ).toString();
        }
        const d = await this.create<Production>(
          tx,
          s,
          id,
          "production",
          recipe.title,
          {
            recipe: recipe.data,
            recipeId: recipe.id,
            recipeVersion: recipe.version,
            warehouseId: c.warehouseId,
            quantity: c.quantity,
            salesOrderId: c.salesOrderId,
            equipmentId: c.equipmentId,
            requirements,
            issued: [],
            costMinor: "0",
            plannedMaterialCostMinor,
            stages: recipe.data.stages.map(() => false),
            defects: "0",
            reworked: "0",
          },
          "planned",
          c.note,
        );
        await this.items(tx, s, id, [
          recipe.data.outputItemId,
          ...requirements.map((x) => x.itemId),
        ]);
        if (c.equipmentId) {
          if (!c.startsAt || !c.endsAt)
            throw new AppError("SCHEDULE_REQUIRED", 422);
          await this.book(tx, s, id, [c.equipmentId], c.startsAt, c.endsAt, [
            "equipment",
          ]);
        }
        return d;
      }
      case "production_issue": {
        const d = await this.load<Production>(tx, s.org, id, "production");
        if (!["planned", "in_progress"].includes(d.state))
          throw new AppError("INDUSTRY_STATE", 409);
        if (!c.materials.length) throw new AppError("MATERIALS_REQUIRED", 422);
        const materials = await this.materials(tx, s, c.materials);
        if (
          materials.some(
            (x) => !d.data.requirements.some((y) => y.itemId === x.itemId),
          )
        )
          throw new AppError("ITEM_MISMATCH", 422);
        const cost = await this.consume(
          tx,
          s,
          id,
          c.key,
          d.data.warehouseId,
          materials,
          c.note,
        );
        d.data.issued.push(...materials);
        d.data.costMinor = (BigInt(d.data.costMinor) + cost).toString();
        await this.save(tx, s, d, "production.issue", c.note, "in_progress");
        return;
      }
      case "production_stage": {
        const d = await this.load<Production>(tx, s.org, id, "production");
        if (d.state !== "in_progress" || c.stage >= d.data.stages.length)
          throw new AppError("INDUSTRY_STATE", 409);
        if (d.data.stages.slice(0, c.stage).some((x) => !x))
          throw new AppError("PREVIOUS_STAGE_REQUIRED", 409);
        d.data.defects = exact(new D(d.data.defects).plus(c.defects));
        d.data.reworked = exact(new D(d.data.reworked).plus(c.reworked));
        if (
          new D(d.data.defects).gt(d.data.quantity) ||
          new D(d.data.reworked).gt(d.data.defects)
        )
          throw new AppError("QUANTITY_EXCEEDS", 409);
        d.data.stages[c.stage] = true;
        await this.save(tx, s, d, "production.stage", c.note);
        return;
      }
      case "production_finish": {
        const d = await this.load<Production>(tx, s.org, id, "production");
        if (d.state !== "in_progress" || d.data.stages.some((x) => !x))
          throw new AppError("STAGES_REQUIRED", 409);
        if (
          !new D(c.goodQuantity).plus(c.scrapQuantity).eq(d.data.quantity) ||
          !new D(d.data.defects).minus(d.data.reworked).eq(c.scrapQuantity)
        )
          throw new AppError("OUTPUT_MISMATCH", 409);
        for (const required of d.data.requirements) {
          if (!d.data.issued.some((x) => x.itemId === required.itemId))
            throw new AppError("MATERIALS_REQUIRED", 409);
        }
        const item = await this.item(
          tx,
          s,
          d.data.recipe.outputItemId,
          "goods",
        );
        if (d.data.recipe.mode === "food" && !c.expiresOn)
          throw new AppError("EXPIRY_REQUIRED", 422);
        if (
          c.expiresOn &&
          c.expiresOn < (await organizationClock(tx, s.org)).today
        )
          throw new AppError("LOT_EXPIRED", 422);
        const total = BigInt(d.data.costMinor),
          scrap = new D(c.scrapQuantity).gt(0)
            ? allocatedValue(total, c.scrapQuantity, d.data.quantity)
            : 0n;
        const result = new D(c.goodQuantity).eq(0)
          ? null
          : await new InventoryService(this.db).executeInTransaction(
              tx,
              s.secret,
              s.org,
              {
                key: c.key,
                kind: "receipt",
                warehouseId: d.data.warehouseId,
                itemId: item.id,
                quantity: c.goodQuantity,
                unit: item.base_unit,
                unitCost: "0",
                lot: { code: c.lotCode, expiresOn: c.expiresOn },
                note: c.note,
              },
              undefined,
              total - scrap,
              { documentId: id },
            );
        Object.assign(d.data, {
          goodQuantity: c.goodQuantity,
          scrapQuantity: c.scrapQuantity,
          scrapCostMinor: scrap.toString(),
          lotCode: c.lotCode,
          outputMovementId: result?.id,
        });
        // Keep the equipment booking as historical capacity evidence.
        await this.save(tx, s, d, "production.finished", c.note, "completed");
        return;
      }
      case "waste": {
        await this.warehouse(tx, s, c.warehouseId);
        const item = await this.item(tx, s, c.itemId, "goods");
        await this.create(
          tx,
          s,
          id,
          "waste",
          item.name_ru,
          {
            itemId: c.itemId,
            quantity: c.quantity,
            lotId: c.lotId,
            warehouseId: c.warehouseId,
          },
          "completed",
          c.note,
        );
        await new InventoryService(this.db).executeInTransaction(
          tx,
          s.secret,
          s.org,
          {
            key: c.key,
            kind: "issue",
            warehouseId: c.warehouseId,
            itemId: c.itemId,
            quantity: c.quantity,
            unit: item.base_unit,
            lotId: c.lotId,
            note: c.note,
          },
          undefined,
          undefined,
          { documentId: id, waste: true },
        );
        return;
      }
      default:
        return this.performBusiness(tx, s, c, id, existing);
    }
  }
  private sameBranch(s: Scope, d: { branch_id: string }) {
    if (d.branch_id !== s.branch) throw new AppError("FORBIDDEN", 403);
  }
  private async consume(
    tx: Sql,
    s: Scope,
    id: string,
    key: string,
    warehouseId: string,
    materials: Material[],
    note: string,
  ) {
    await this.warehouse(tx, s, warehouseId);
    let cost = 0n;
    for (const m of [...materials].sort((a, b) =>
      a.itemId.localeCompare(b.itemId),
    )) {
      const result = await new InventoryService(this.db).executeInTransaction(
        tx,
        s.secret,
        s.org,
        {
          ...m,
          key: stableUuid(`${key}:${m.itemId}`),
          kind: "issue",
          warehouseId,
          note,
        },
        undefined,
        undefined,
        { documentId: id },
      );
      const [v] = await tx.query<{ value: string }>(
        "SELECT value_minor::text value FROM stock_movements WHERE organization_id=$1 AND id=$2",
        [s.org, result.id],
      );
      cost -= BigInt(v.value);
    }
    return cost;
  }
  private async book(
    tx: Sql,
    s: Scope,
    id: string,
    ids: string[],
    start: string,
    end: string,
    required: string[],
  ) {
    unique(ids);
    const begins = new Date(start),
      ends = new Date(end);
    if (ends <= begins || ends.getTime() - begins.getTime() > 24 * 3600000)
      throw new AppError("INVALID_RANGE", 422);
    const clock = await organizationClock(tx, s.org);
    const current = await this.load<Appointment>(tx, s.org, id);
    if (current.kind === "appointment" && current.data.mode === "lesson") {
      const overlap = await tx.query(
        "SELECT id FROM industry_documents WHERE organization_id=$1 AND id<>$2 AND kind='appointment' AND data->>'mode'='lesson' AND data->>'groupId'=$3 AND state IN ('scheduled','completed') AND (data->>'startsAt')::timestamptz<$5::timestamptz AND (data->>'endsAt')::timestamptz>$4::timestamptz",
        [s.org, id, current.data.groupId, start, end],
      );
      if (overlap.length) throw new AppError("RESOURCE_CONFLICT", 409);
    }
    const types: string[] = [];
    const resources: Doc<Resource>[] = [];
    for (const resource of [...ids].sort()) {
      const r = await this.load<Resource>(tx, s.org, resource, "resource");
      this.sameBranch(s, r);
      resources.push(r);
      types.push(r.data.resourceKind);
    }
    if (required.some((t) => !types.includes(t)))
      throw new AppError("RESOURCE_KIND", 422);
    // Keep old slots until every new resource has been validated; rollback preserves a failed move.
    await tx.query(
      "DELETE FROM industry_slots WHERE organization_id=$1 AND document_id=$2",
      [s.org, id],
    );
    for (const r of resources) {
      const from = new Date(
          begins.getTime() - r.data.bufferMinutes * 60000,
        ).toISOString(),
        to = new Date(
          ends.getTime() + r.data.bufferMinutes * 60000,
        ).toISOString();
      const [local] = await tx.query<{
        day: number;
        start: string;
        end: string;
        same: boolean;
      }>(
        'SELECT extract(isodow FROM $1::timestamptz AT TIME ZONE $3)::int "day",to_char($1::timestamptz AT TIME ZONE $3,\'HH24:MI\') "start",to_char($2::timestamptz AT TIME ZONE $3,\'HH24:MI\') "end",($1::timestamptz AT TIME ZONE $3)::date=($2::timestamptz AT TIME ZONE $3)::date same',
        [from, to, clock.timezone],
      );
      if (
        !local.same ||
        !r.data.days.includes(local.day) ||
        local.start < r.data.opens ||
        local.end > r.data.closes
      )
        throw new AppError("OUTSIDE_WORKING_HOURS", 409);
      const overlap = await tx.query<{ start: string; end: string }>(
        'SELECT greatest(starts_at,$3::timestamptz)::text "start",least(ends_at,$4::timestamptz)::text "end" FROM industry_slots WHERE organization_id=$1 AND resource_id=$2 AND starts_at<$4::timestamptz AND ends_at>$3::timestamptz',
        [s.org, r.id, from, to],
      );
      const events = overlap
        .flatMap((x) => [
          { time: new Date(x.start).getTime(), delta: 1 },
          { time: new Date(x.end).getTime(), delta: -1 },
        ])
        .sort((a, b) => a.time - b.time || a.delta - b.delta);
      let concurrent = 0;
      for (const event of events) {
        concurrent += event.delta;
        if (concurrent >= r.data.capacity)
          throw new AppError("RESOURCE_CONFLICT", 409);
      }
      await tx.query(
        "INSERT INTO industry_slots(organization_id,document_id,resource_id,starts_at,ends_at) VALUES($1,$2,$3,$4,$5)",
        [s.org, id, r.id, from, to],
      );
    }
  }
  private async invoice(
    tx: Sql,
    s: Scope,
    id: string,
    key: string,
    customerId: string,
    warehouseId: string,
    lines: {
      itemId: string;
      quantity: string;
      unit: string;
      price: string;
      discount: string;
    }[],
    cost: bigint | null,
  ) {
    const commerce = new CommerceService(this.db);
    const result = await commerce.createInTransaction(tx, s.secret, s.org, {
      key: stableUuid(`${key}:order`),
      branchId: s.branch,
      customerId,
      warehouseId,
      lines,
      dueDate: (await organizationClock(tx, s.org)).today,
      delivery: "pickup",
      note: `Документ / Құжат ${id}`,
      taxMode: "excluded",
    });
    await commerce.transitionInTransaction(tx, s.secret, s.org, result.id, {
      key: stableUuid(`${key}:confirm`),
      version: 1,
      kind: "confirm",
      note: "Подтверждение / Растау",
    });
    const rows = await tx.query<{ id: string; quantity: string }>(
      "SELECT id,quantity::text FROM sales_order_lines WHERE organization_id=$1 AND order_id=$2 ORDER BY id",
      [s.org, result.id],
    );
    let version = 2;
    for (const row of rows)
      await commerce.transitionInTransaction(tx, s.secret, s.org, result.id, {
        key: stableUuid(`${key}:${row.id}:fulfill`),
        version: version++,
        kind: "fulfill",
        lineId: row.id,
        quantity: row.quantity,
        note: "Исполнено / Орындалды",
        ...(cost !== null && rows.length === 1
          ? { serviceCost: kzt(cost) }
          : {}),
      });
    return result.id;
  }
  private async performBusiness(
    tx: Sql,
    s: Scope,
    c: IndustryCommand,
    id: string,
    existing: Doc | null,
  ) {
    return this.business(tx, s, c, id, existing);
  }
  private async business(
    tx: Sql,
    s: Scope,
    c: IndustryCommand,
    id: string,
    existing: Doc | null,
  ): Promise<void> {
    void existing;
    switch (c.kind) {
      case "resource": {
        if (c.opens >= c.closes) throw new AppError("INVALID_RANGE", 422);
        if (
          ["specialist", "teacher", "workplace"].includes(c.resourceKind) &&
          c.capacity !== 1
        )
          throw new AppError("RESOURCE_CAPACITY", 422);
        await this.create<Resource>(tx, s, id, "resource", c.title, {
          resourceKind: c.resourceKind,
          capacity: c.capacity,
          bufferMinutes: c.bufferMinutes,
          days: c.days,
          opens: c.opens,
          closes: c.closes,
        });
        return;
      }
      case "appointment": {
        await this.customer(tx, s, c.customerId);
        await this.warehouse(tx, s, c.warehouseId);
        const service = await this.item(tx, s, c.serviceItemId, "service");
        if (
          c.inquiryId &&
          !(
            await tx.query(
              "SELECT id FROM inquiries WHERE organization_id=$1 AND branch_id=$2 AND customer_id=$3 AND id=$4",
              [s.org, s.branch, c.customerId, c.inquiryId],
            )
          ).length
        )
          throw new AppError("INQUIRY_SCOPE", 403);
        const materials = await this.materials(tx, s, c.materials);
        await this.create<Appointment>(
          tx,
          s,
          id,
          "appointment",
          service.name_ru,
          {
            mode: "service",
            startsAt: c.startsAt,
            endsAt: c.endsAt,
            resources: c.resources,
            customerId: c.customerId,
            inquiryId: c.inquiryId,
            serviceItemId: c.serviceItemId,
            price: c.price,
            warehouseId: c.warehouseId,
            materials,
            orderIds: [],
          },
          "scheduled",
          c.note,
        );
        await this.items(tx, s, id, [
          c.serviceItemId,
          ...materials.map((x) => x.itemId),
        ]);
        await this.book(tx, s, id, c.resources, c.startsAt, c.endsAt, [
          "specialist",
          "workplace",
        ]);
        return;
      }
      case "reschedule": {
        const d = await this.load<Appointment>(tx, s.org, id, "appointment");
        if (d.state !== "scheduled") throw new AppError("INDUSTRY_STATE", 409);
        await this.book(
          tx,
          s,
          id,
          c.resources,
          c.startsAt,
          c.endsAt,
          d.data.mode === "lesson"
            ? ["teacher", "room"]
            : ["specialist", "workplace"],
        );
        Object.assign(d.data, {
          startsAt: c.startsAt,
          endsAt: c.endsAt,
          resources: c.resources,
        });
        await this.save(tx, s, d, "appointment.moved", c.note);
        return;
      }
      case "appointment_end": {
        const d = await this.load<Appointment>(tx, s.org, id, "appointment");
        if (d.state !== "scheduled" || d.data.mode !== "service")
          throw new AppError("INDUSTRY_STATE", 409);
        if (c.outcome === "completed") {
          if (new Date(d.data.startsAt) > new Date())
            throw new AppError("VISIT_NOT_STARTED", 409);
          const cost = await this.consume(
              tx,
              s,
              id,
              c.key,
              d.data.warehouseId!,
              d.data.materials!,
              c.note,
            ),
            item = await this.item(tx, s, d.data.serviceItemId!, "service");
          const order = await this.invoice(
            tx,
            s,
            id,
            c.key,
            d.data.customerId!,
            d.data.warehouseId!,
            [
              {
                itemId: item.id,
                quantity: "1",
                unit: item.base_unit,
                price: d.data.price!,
                discount: "0",
              },
            ],
            cost,
          );
          d.data.orderIds.push(order);
          d.data.materialCostMinor = cost.toString();
          if (d.data.inquiryId)
            await tx.query(
              "UPDATE sales_orders SET inquiry_id=$3 WHERE organization_id=$1 AND id=$2",
              [s.org, order, d.data.inquiryId],
            );
        }
        if (c.outcome !== "completed")
          await tx.query(
            "DELETE FROM industry_slots WHERE organization_id=$1 AND document_id=$2",
            [s.org, id],
          );
        await this.save(
          tx,
          s,
          d,
          `appointment.${c.outcome}`,
          c.note,
          c.outcome,
        );
        return;
      }
      case "reminder": {
        const d = await this.load<Appointment>(tx, s.org, id, "appointment");
        if (d.data.mode !== "service" || d.state === "cancelled")
          throw new AppError("INDUSTRY_STATE", 409);
        const conn = await connectionFor(tx, s.org, c.connectionId, "telegram");
        const result = await new TelegramService(this.db).queueInTransaction(
          tx,
          s.org,
          s.actor,
          conn,
          d.data.customerId!,
          c.text,
          { id: stableUuid(`${c.key}:reminder`), branchId: s.branch },
        );
        if (result !== "queued") throw new AppError("NO_CONSENT", 409);
        await this.save(tx, s, d, "appointment.reminder_queued", c.note);
        return;
      }
      case "course": {
        await this.item(tx, s, c.serviceItemId, "service");
        await this.warehouse(tx, s, c.warehouseId);
        await this.create<Course>(tx, s, id, "course", c.title, {
          serviceItemId: c.serviceItemId,
          warehouseId: c.warehouseId,
          lessonPrice: c.lessonPrice,
          lessons: c.lessons,
        });
        await this.items(tx, s, id, [c.serviceItemId]);
        return;
      }
      case "group": {
        const course = await this.load<Course>(tx, s.org, c.courseId, "course");
        this.sameBranch(s, course);
        await this.create<Group>(tx, s, id, "group", c.title, {
          course: course.data,
          courseId: course.id,
          capacity: c.capacity,
        });
        return;
      }
      case "enroll": {
        if (
          c.inquiryId &&
          !(
            await tx.query(
              "SELECT id FROM inquiries WHERE organization_id=$1 AND branch_id=$2 AND customer_id=$3 AND id=$4",
              [s.org, s.branch, c.customerId, c.inquiryId],
            )
          ).length
        )
          throw new AppError("INQUIRY_SCOPE", 403);
        const group = await this.load<Group>(tx, s.org, c.groupId, "group");
        this.sameBranch(s, group);
        await this.customer(tx, s, c.customerId);
        if (c.guardianId) await this.customer(tx, s, c.guardianId);
        const rows = await tx.query<Doc<Enrollment>>(
          `SELECT ${columns} FROM industry_documents WHERE organization_id=$1 AND kind='enrollment' AND data->>'groupId'=$2 AND state IN ('active','frozen')`,
          [s.org, c.groupId],
        );
        if (rows.some((x) => x.data.customerId === c.customerId))
          throw new AppError("ALREADY_ENROLLED", 409);
        if (rows.length >= group.data.capacity)
          throw new AppError("GROUP_FULL", 409);
        if (c.endsOn < (await organizationClock(tx, s.org)).today)
          throw new AppError("INVALID_RANGE", 422);
        await this.create<Enrollment>(
          tx,
          s,
          id,
          "enrollment",
          group.title,
          {
            groupId: c.groupId,
            customerId: c.customerId,
            guardianId: c.guardianId,
            inquiryId: c.inquiryId,
            endsOn: c.endsOn,
            frozenUntil: null,
            attended: 0,
            lessonLimit: group.data.course.lessons,
            orderIds: [],
          },
          "active",
          c.note,
        );
        return;
      }
      case "enrollment_change": {
        const d = await this.load<Enrollment>(tx, s.org, id, "enrollment");
        if (!["active", "frozen"].includes(d.state))
          throw new AppError("INDUSTRY_STATE", 409);
        if (c.action === "extend") {
          if (!c.until || c.until <= d.data.endsOn)
            throw new AppError("INVALID_RANGE", 422);
          d.data.endsOn = c.until;
          d.data.lessonLimit += c.additionalLessons;
        } else if (c.additionalLessons)
          throw new AppError("INVALID_RANGE", 422);
        if (c.action === "freeze") {
          if (
            d.state !== "active" ||
            !c.until ||
            c.until < (await organizationClock(tx, s.org)).today
          )
            throw new AppError("INVALID_RANGE", 422);
          d.data.frozenUntil = c.until;
        }
        if (c.action === "resume") {
          if (d.state !== "frozen") throw new AppError("INDUSTRY_STATE", 409);
          d.data.frozenUntil = null;
        }
        await this.save(
          tx,
          s,
          d,
          `enrollment.${c.action}`,
          c.note,
          c.action === "withdraw"
            ? "withdrawn"
            : c.action === "freeze"
              ? "frozen"
              : c.action === "resume"
                ? "active"
                : d.state,
        );
        return;
      }
      case "lesson": {
        const group = await this.load<Group>(tx, s.org, c.groupId, "group");
        this.sameBranch(s, group);
        await this.create<Appointment>(
          tx,
          s,
          id,
          "appointment",
          group.title,
          {
            mode: "lesson",
            groupId: group.id,
            startsAt: c.startsAt,
            endsAt: c.endsAt,
            resources: c.resources,
            orderIds: [],
          },
          "scheduled",
          c.note,
        );
        await this.book(tx, s, id, c.resources, c.startsAt, c.endsAt, [
          "teacher",
          "room",
        ]);
        return;
      }
      case "lesson_complete": {
        const d = await this.load<Appointment>(tx, s.org, id, "appointment");
        if (d.state !== "scheduled" || d.data.mode !== "lesson")
          throw new AppError("INDUSTRY_STATE", 409);
        if (new Date(d.data.startsAt) > new Date())
          throw new AppError("VISIT_NOT_STARTED", 409);
        const group = await this.load<Group>(
          tx,
          s.org,
          d.data.groupId!,
          "group",
        );
        const [{ date }] = await tx.query<{ date: string }>(
          "SELECT ($1::timestamptz AT TIME ZONE timezone)::date::text date FROM organizations WHERE id=$2",
          [d.data.startsAt, s.org],
        );
        const all = await tx.query<Doc<Enrollment>>(
          `SELECT ${columns} FROM industry_documents WHERE organization_id=$1 AND kind='enrollment' AND data->>'groupId'=$2 AND state='active' AND data->>'endsOn'>=$3 ORDER BY id FOR UPDATE`,
          [s.org, group.id, date],
        );
        unique(c.attendance.map((x) => x.enrollmentId));
        if (
          c.attendance.length !== all.length ||
          c.attendance.some((a) => !all.some((e) => e.id === a.enrollmentId))
        )
          throw new AppError("ATTENDANCE_INCOMPLETE", 422);
        const item = await this.item(
          tx,
          s,
          group.data.course.serviceItemId,
          "service",
        );
        for (const e of all) {
          if (!c.attendance.find((x) => x.enrollmentId === e.id)!.present)
            continue;
          if (e.data.attended >= e.data.lessonLimit)
            throw new AppError("COURSE_LIMIT", 409);
          const order = await this.invoice(
            tx,
            s,
            id,
            `${c.key}:${e.id}`,
            e.data.customerId,
            group.data.course.warehouseId,
            [
              {
                itemId: item.id,
                quantity: "1",
                unit: item.base_unit,
                price: group.data.course.lessonPrice,
                discount: "0",
              },
            ],
            null,
          );
          e.data.attended++;
          e.data.orderIds.push(order);
          if (e.data.inquiryId)
            await tx.query(
              "UPDATE sales_orders SET inquiry_id=$3 WHERE organization_id=$1 AND id=$2",
              [s.org, order, e.data.inquiryId],
            );
          d.data.orderIds.push(order);
          await this.save(tx, s, e, "enrollment.attended", c.note);
        }
        d.data.attendance = c.attendance;
        await this.save(tx, s, d, "lesson.completed", c.note, "completed");
        return;
      }
      case "project": {
        const [q] = await tx.query<{
          id: string;
          version: number;
          customer_id: string;
          branch_id: string;
          order_id: string | null;
          data: {
            validUntil: string;
            total_minor: string;
            lines: Project["lines"];
          };
        }>(
          "SELECT q.id,q.version,i.customer_id,i.branch_id,q.order_id,q.data FROM quotes q JOIN inquiries i ON i.organization_id=q.organization_id AND i.id=q.inquiry_id WHERE q.organization_id=$1 AND q.id=$2 FOR UPDATE OF q",
          [s.org, c.quoteId],
        );
        if (!q) throw new AppError("NOT_FOUND", 404);
        this.sameBranch(s, q);
        if (q.order_id) throw new AppError("QUOTE_CONVERTED", 409);
        if (q.data.validUntil < (await organizationClock(tx, s.org)).today)
          throw new AppError("QUOTE_EXPIRED", 409);
        if (
          (
            await tx.query(
              "SELECT id FROM industry_documents WHERE organization_id=$1 AND kind='project' AND data->>'quoteId'=$2",
              [s.org, c.quoteId],
            )
          ).length
        )
          throw new AppError("QUOTE_CONVERTED", 409);
        await this.warehouse(tx, s, c.warehouseId);
        unique(c.team);
        for (const member of c.team)
          if (
            !(
              await tx.query(
                "SELECT user_id FROM memberships WHERE organization_id=$1 AND user_id=$2 AND (branch_id IS NULL OR branch_id=$3)",
                [s.org, member, s.branch],
              )
            ).length
          )
            throw new AppError("ASSIGNEE_SCOPE", 403);
        for (const line of q.data.lines)
          await this.item(tx, s, line.itemId, "service");
        await this.create<Project>(
          tx,
          s,
          id,
          "project",
          c.title,
          {
            quoteId: q.id,
            quoteVersion: q.version,
            customerId: q.customer_id,
            warehouseId: c.warehouseId,
            budget: c.budget,
            estimatedHours: c.estimatedHours,
            tasks: [],
            priceMinor: q.data.total_minor,
            team: c.team,
            stages: c.stages,
            done: c.stages.map(() => false),
            time: [],
            costMinor: "0",
            change: null,
            changes: [],
            lines: q.data.lines,
            orderId: null,
          },
          "active",
          c.note,
        );
        await this.items(
          tx,
          s,
          id,
          q.data.lines.map((x) => x.itemId),
        );
        return;
      }
      case "project_task": {
        const d = await this.load<Project>(tx, s.org, id, "project");
        if (
          d.state !== "active" ||
          !d.data.team.includes(c.memberId) ||
          c.stage >= d.data.stages.length ||
          d.data.done[c.stage]
        )
          throw new AppError("INDUSTRY_STATE", 409);
        const task = await new TaskService(this.db).createInTransaction(
          tx,
          s.secret,
          s.org,
          {
            key: stableUuid(`${c.key}:task`),
            branchId: s.branch,
            title: c.title,
            description: c.note,
            assigneeId: c.memberId,
            requiresVerification: true,
            links: [{ type: "customer", id: d.data.customerId }],
          },
          { sourceId: id },
        );
        d.data.tasks.push({ id: task.id, stage: c.stage });
        await this.save(tx, s, d, "project.task", c.note);
        return;
      }
      case "time": {
        const d = await this.load<Project>(tx, s.org, id, "project");
        if (
          d.state !== "active" ||
          c.stage >= d.data.stages.length ||
          d.data.done[c.stage]
        )
          throw new AppError("INDUSTRY_STATE", 409);
        if (
          !d.data.team.includes(c.memberId) ||
          !(
            await tx.query(
              "SELECT user_id FROM memberships WHERE organization_id=$1 AND user_id=$2 AND (branch_id IS NULL OR branch_id=$3)",
              [s.org, c.memberId, s.branch],
            )
          ).length
        )
          throw new AppError("ASSIGNEE_SCOPE", 403);
        if (c.workedOn > (await organizationClock(tx, s.org)).today)
          throw new AppError("INVALID_RANGE", 422);
        const [hours] = await tx.query<{ n: string }>(
          "SELECT coalesce(sum((t->>'hours')::numeric),0)::text n FROM industry_documents d CROSS JOIN LATERAL jsonb_array_elements(d.data->'time') t WHERE d.organization_id=$1 AND d.kind='project' AND t->>'memberId'=$2 AND t->>'workedOn'=$3",
          [s.org, c.memberId, c.workedOn],
        );
        if (new D(hours.n).plus(c.hours).gt(24))
          throw new AppError("TIME_LIMIT", 409);
        const cost = lineAmount(c.hourlyRate, c.hours),
          next = BigInt(d.data.costMinor) + cost;
        if (next > minorUnits(d.data.budget))
          throw new AppError("BUDGET_EXCEEDED", 409);
        d.data.time.push({
          memberId: c.memberId,
          stage: c.stage,
          hours: c.hours,
          hourlyRate: c.hourlyRate,
          workedOn: c.workedOn,
          costMinor: cost.toString(),
          note: c.note,
        });
        d.data.costMinor = next.toString();
        await this.save(tx, s, d, "project.time", c.note);
        return;
      }
      case "scope_change": {
        const d = await this.load<Project>(tx, s.org, id, "project");
        if (d.state !== "active") throw new AppError("INDUSTRY_STATE", 409);
        if (minorUnits(c.budget) < BigInt(d.data.costMinor))
          throw new AppError("BUDGET_EXCEEDED", 409);
        d.data.change = {
          budget: c.budget,
          extraPrice: c.extraPrice,
          description: c.description,
          authorId: s.actor,
        };
        await this.save(tx, s, d, "project.scope_proposed", c.note);
        return;
      }
      case "scope_approve": {
        const d = await this.load<Project>(tx, s.org, id, "project");
        if (d.state !== "active" || !d.data.change)
          throw new AppError("INDUSTRY_STATE", 409);
        if (d.data.change.authorId === s.actor)
          throw new AppError("SECOND_PERSON_REQUIRED", 403);
        d.data.budget = d.data.change.budget;
        d.data.priceMinor = (
          BigInt(d.data.priceMinor) + minorUnits(d.data.change.extraPrice)
        ).toString();
        d.data.changes.push({ ...d.data.change, approverId: s.actor });
        d.data.change = null;
        await this.save(tx, s, d, "project.scope_approved", c.note);
        return;
      }
      case "project_stage": {
        const d = await this.load<Project>(tx, s.org, id, "project");
        if (
          d.state !== "active" ||
          c.stage >= d.data.done.length ||
          d.data.done[c.stage]
        )
          throw new AppError("INDUSTRY_STATE", 409);
        if (d.data.done.slice(0, c.stage).some((x) => !x))
          throw new AppError("PREVIOUS_STAGE_REQUIRED", 409);
        for (const task of d.data.tasks.filter((t) => t.stage === c.stage)) {
          const [row] = await tx.query<{ state: string }>(
            "SELECT state FROM tasks WHERE organization_id=$1 AND id=$2 FOR SHARE",
            [s.org, task.id],
          );
          if (!row || !["verified", "cancelled"].includes(row.state))
            throw new AppError("PROJECT_TASKS_OPEN", 409);
        }
        d.data.done[c.stage] = true;
        await this.save(tx, s, d, "project.stage_accepted", c.note);
        return;
      }
      case "project_deliver": {
        const d = await this.load<Project>(tx, s.org, id, "project");
        if (
          d.state !== "active" ||
          d.data.change ||
          d.data.done.some((x) => !x)
        )
          throw new AppError("STAGES_REQUIRED", 409);
        const [quote] = await tx.query<{
          order_id: string | null;
          inquiry_id: string;
        }>(
          "SELECT order_id,inquiry_id FROM quotes WHERE organization_id=$1 AND id=$2 FOR UPDATE",
          [s.org, d.data.quoteId],
        );
        if (quote.order_id) throw new AppError("QUOTE_CONVERTED", 409);
        const item = await this.item(tx, s, d.data.lines[0].itemId, "service");
        d.data.orderId = await this.invoice(
          tx,
          s,
          id,
          c.key,
          d.data.customerId,
          d.data.warehouseId,
          [
            {
              itemId: item.id,
              quantity: "1",
              unit: item.base_unit,
              price: kzt(d.data.priceMinor),
              discount: "0",
            },
          ],
          d.data.time.length ? BigInt(d.data.costMinor) : null,
        );
        await tx.query(
          "UPDATE sales_orders SET quote_id=$3,inquiry_id=$4 WHERE organization_id=$1 AND id=$2",
          [s.org, d.data.orderId, d.data.quoteId, quote.inquiry_id],
        );
        await tx.query(
          "UPDATE quotes SET order_id=$3,version=version+1 WHERE organization_id=$1 AND id=$2",
          [s.org, d.data.quoteId, d.data.orderId],
        );
        await this.save(tx, s, d, "project.delivered", c.note, "completed");
        return;
      }
      default:
        return this.extended(tx, s, c, id);
    }
  }
  private async constructionBudget(tx: Sql, s: Scope, d: Construction) {
    const [row] = await tx.query<{ total: string }>(
      "SELECT coalesce(sum(greatest(o.total_minor,coalesce((SELECT sum(amount_minor) FROM supplier_obligations b WHERE b.organization_id=o.organization_id AND b.purchase_order_id=o.id),0))),0)::text total FROM purchase_orders o WHERE o.organization_id=$1 AND o.id=ANY($2::uuid[]) AND o.state<>'cancelled'",
      [s.org, d.purchases],
    );
    const work = d.work.reduce((n, w) => n + minorUnits(w.amount), 0n);
    const material =
      BigInt(row.total) > BigInt(d.materialCostMinor)
        ? BigInt(row.total)
        : BigInt(d.materialCostMinor);
    if (material + work > minorUnits(d.budget))
      throw new AppError("BUDGET_EXCEEDED", 409);
  }
  private async estimate(
    tx: Sql,
    s: Scope,
    data: Pick<Construction, "lines" | "stages">,
  ) {
    unique(data.lines.map((l) => l.itemId));
    let price = 0n;
    for (const l of data.lines) {
      toBase(l.quantity, l.unit, await this.item(tx, s, l.itemId));
      price += lineAmount(l.price, l.quantity);
    }
    return price.toString();
  }
  private async extended(
    tx: Sql,
    s: Scope,
    c: IndustryCommand,
    id: string,
  ): Promise<void> {
    switch (c.kind) {
      case "construction": {
        await this.customer(tx, s, c.customerId);
        await this.warehouse(tx, s, c.warehouseId);
        await this.item(tx, s, c.billingItemId, "service");
        await this.create<Construction>(
          tx,
          s,
          id,
          "construction",
          c.title,
          {
            customerId: c.customerId,
            warehouseId: c.warehouseId,
            billingItemId: c.billingItemId,
            budget: c.budget,
            lines: c.lines,
            stages: c.stages,
            estimateVersion: 1,
            authorId: s.actor,
            approverId: null,
            priceMinor: await this.estimate(tx, s, c),
            materialCostMinor: "0",
            issued: [],
            purchases: [],
            work: [],
            orderId: null,
          },
          "pending",
          c.note,
        );
        await this.items(tx, s, id, [
          c.billingItemId,
          ...c.lines.map((l) => l.itemId),
        ]);
        return;
      }
      case "construction_revise": {
        const d = await this.load<Construction>(tx, s.org, id, "construction");
        if (!["pending", "active"].includes(d.state))
          throw new AppError("INDUSTRY_STATE", 409);
        // Existing work and purchased quantities survive a new estimate; approval is invalidated.
        if (
          d.data.work.some((w) => c.stages[w.stage] !== d.data.stages[w.stage])
        )
          throw new AppError("ESTIMATE_COMMITTED", 409);
        for (const used of await purchaseQuantities(
          tx,
          s.org,
          d.data.purchases,
          true,
        )) {
          const item = await this.item(tx, s, used.item_id);
          const next = c.lines.find((l) => l.itemId === used.item_id);
          if (
            new D(used.quantity).gt(
              next ? toBase(next.quantity, next.unit, item) : "0",
            )
          )
            throw new AppError("ESTIMATE_COMMITTED", 409);
        }
        d.data.lines = c.lines;
        d.data.stages = c.stages;
        d.data.budget = c.budget;
        d.data.priceMinor = await this.estimate(tx, s, c);
        d.data.estimateVersion++;
        d.data.authorId = s.actor;
        d.data.approverId = null;
        await this.constructionBudget(tx, s, d.data);
        await this.items(
          tx,
          s,
          id,
          c.lines.map((l) => l.itemId),
        );
        await this.save(tx, s, d, "construction.revised", c.note, "pending");
        return;
      }
      case "construction_approve": {
        const d = await this.load<Construction>(tx, s.org, id, "construction");
        if (d.state !== "pending") throw new AppError("INDUSTRY_STATE", 409);
        if (s.actor === d.data.authorId)
          throw new AppError("SECOND_PERSON_REQUIRED", 403);
        await this.constructionBudget(tx, s, d.data);
        d.data.approverId = s.actor;
        await this.save(tx, s, d, "construction.approved", c.note, "active");
        return;
      }
      case "construction_purchase": {
        const d = await this.load<Construction>(tx, s.org, id, "construction");
        if (d.state !== "active") throw new AppError("INDUSTRY_STATE", 409);
        const result = await new PurchasingService(this.db).createInTransaction(
          tx,
          s.secret,
          s.org,
          {
            key: stableUuid(`${c.key}:purchase`),
            branchId: s.branch,
            warehouseId: d.data.warehouseId,
            supplierId: c.supplierId,
            date: c.date,
            dueDate: c.dueDate,
            budget: d.data.budget,
            lines: c.lines,
            note: c.note,
          },
        );
        d.data.purchases.push(result.id);
        const lines = await purchaseQuantities(
          tx,
          s.org,
          d.data.purchases,
          true,
        );
        for (const line of lines) {
          const estimate = d.data.lines.find((l) => l.itemId === line.item_id);
          const item = await this.item(tx, s, line.item_id, "goods");
          if (
            !estimate ||
            new D(line.quantity).gt(
              toBase(estimate.quantity, estimate.unit, item),
            )
          )
            throw new AppError("ESTIMATE_COMMITTED", 409);
        }
        await this.constructionBudget(tx, s, d.data);
        await tx.query(
          "INSERT INTO construction_purchases(organization_id,document_id,purchase_id) VALUES($1,$2,$3)",
          [s.org, id, result.id],
        );
        await this.save(tx, s, d, "construction.purchase", c.note);
        return;
      }
      case "construction_materials": {
        const d = await this.load<Construction>(tx, s.org, id, "construction");
        if (d.state !== "active") throw new AppError("INDUSTRY_STATE", 409);
        const materials = await this.materials(tx, s, c.materials);
        for (const m of materials) {
          const received = (
            await purchaseQuantities(tx, s.org, d.data.purchases)
          ).find((l) => l.item_id === m.itemId);
          const used = d.data.issued
            .filter((l) => l.itemId === m.itemId)
            .reduce((n, l) => n.plus(l.quantity), new D(0));
          if (used.plus(m.quantity).gt(received?.quantity ?? "0"))
            throw new AppError("RECEIPT_REQUIRED", 409);
          const line = d.data.lines.find((l) => l.itemId === m.itemId);
          if (
            !line ||
            used
              .plus(m.quantity)
              .gt(
                toBase(
                  line.quantity,
                  line.unit,
                  await this.item(tx, s, m.itemId),
                ),
              )
          )
            throw new AppError("ESTIMATE_COMMITTED", 409);
        }
        const cost = await this.consume(
          tx,
          s,
          id,
          c.key,
          d.data.warehouseId,
          materials,
          c.note,
        );
        d.data.materialCostMinor = (
          BigInt(d.data.materialCostMinor) + cost
        ).toString();
        d.data.issued.push(...materials);
        await this.constructionBudget(tx, s, d.data);
        await this.save(tx, s, d, "construction.materials", c.note);
        return;
      }
      case "construction_work": {
        const d = await this.load<Construction>(tx, s.org, id, "construction");
        if (d.state !== "active" || c.stage >= d.data.stages.length)
          throw new AppError("INDUSTRY_STATE", 409);
        if (
          !(
            await tx.query(
              "SELECT id FROM suppliers WHERE organization_id=$1 AND id=$2",
              [s.org, c.contractorId],
            )
          ).length
        )
          throw new AppError("NOT_FOUND", 404);
        if (
          d.data.stages
            .slice(0, c.stage)
            .some(
              (_, i) =>
                !d.data.work.some((w) => w.stage === i && w.confirmedBy),
            )
        )
          throw new AppError("PREVIOUS_STAGE_REQUIRED", 409);
        d.data.work.push({
          id: randomUUID(),
          stage: c.stage,
          contractorId: c.contractorId,
          amount: c.amount,
          evidence: c.evidence,
          authorId: s.actor,
          confirmedBy: null,
        });
        await this.constructionBudget(tx, s, d.data);
        await this.save(tx, s, d, "construction.work", c.note);
        return;
      }
      case "construction_confirm": {
        const d = await this.load<Construction>(tx, s.org, id, "construction");
        const work = d.data.work.find((w) => w.id === c.workId);
        if (d.state !== "active" || !work || work.confirmedBy)
          throw new AppError("INDUSTRY_STATE", 409);
        if (work.authorId === s.actor)
          throw new AppError("SECOND_PERSON_REQUIRED", 403);
        if (minorUnits(work.amount) > 0n) {
          const [contractor] = await tx.query<{ name: string }>(
            "SELECT name FROM suppliers WHERE organization_id=$1 AND id=$2",
            [s.org, work.contractorId],
          );
          work.obligationId = (
            await new CommerceService(this.db).createObligationInTransaction(
              tx,
              s.secret,
              s.org,
              {
                key: stableUuid(c.key + ":obligation"),
                branchId: s.branch,
                supplier: contractor.name,
                amount: work.amount,
                dueDate: (await organizationClock(tx, s.org)).today,
                note: c.note,
              },
            )
          ).id;
        }
        work.confirmedBy = s.actor;
        await this.save(tx, s, d, "construction.work_confirmed", c.note);
        return;
      }
      case "construction_accept": {
        const d = await this.load<Construction>(tx, s.org, id, "construction");
        if (
          d.state !== "active" ||
          d.data.work.some((w) => !w.confirmedBy) ||
          d.data.stages.some((_, i) => !d.data.work.some((w) => w.stage === i))
        )
          throw new AppError("PROJECT_TASKS_OPEN", 409);
        if (
          (
            await tx.query(
              "SELECT id FROM purchase_orders WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND state NOT IN ('completed','cancelled')",
              [s.org, d.data.purchases],
            )
          ).length
        )
          throw new AppError("RECEIPT_REQUIRED", 409);
        for (const line of d.data.lines) {
          const item = await this.item(tx, s, line.itemId);
          if (
            item.kind === "goods" &&
            !new D(toBase(line.quantity, line.unit, item)).eq(
              d.data.issued
                .filter((m) => m.itemId === item.id)
                .reduce((n, m) => n.plus(m.quantity), new D(0)),
            )
          )
            throw new AppError("MATERIALS_REQUIRED", 409);
        }
        await this.constructionBudget(tx, s, d.data);
        const item = await this.item(tx, s, d.data.billingItemId, "service");
        const cost =
          BigInt(d.data.materialCostMinor) +
          d.data.work.reduce((n, w) => n + minorUnits(w.amount), 0n);
        d.data.orderId = await this.invoice(
          tx,
          s,
          id,
          c.key,
          d.data.customerId,
          d.data.warehouseId,
          [
            {
              itemId: item.id,
              unit: item.base_unit,
              quantity: "1",
              price: kzt(d.data.priceMinor),
              discount: "0",
            },
          ],
          cost,
        );
        await this.save(tx, s, d, "construction.accepted", c.note, "completed");
        return;
      }
      case "clinic": {
        await this.item(tx, s, c.serviceItemId, "service");
        await this.warehouse(tx, s, c.warehouseId);
        await this.create<Clinic>(
          tx,
          s,
          id,
          "clinic",
          `Приём / Қабылдау ${id.slice(0, 8)}`,
          {
            patientName: c.patientName,
            contact: c.contact,
            serviceItemId: c.serviceItemId,
            warehouseId: c.warehouseId,
            price: c.price,
            orderId: null,
          },
          "requested",
          "Административная заявка / Әкімшілік өтініш",
        );
        await this.items(tx, s, id, [c.serviceItemId]);
        return;
      }
      case "clinic_book": {
        const d = await this.load<Clinic>(tx, s.org, id, "clinic");
        if (!["requested", "scheduled"].includes(d.state))
          throw new AppError("INDUSTRY_STATE", 409);
        await this.book(tx, s, id, c.resources, c.startsAt, c.endsAt, [
          "specialist",
          "room",
        ]);
        d.data.startsAt = c.startsAt;
        d.data.endsAt = c.endsAt;
        d.data.resources = c.resources;
        await this.save(
          tx,
          s,
          d,
          "clinic.booked",
          "Запись / Жазылу",
          "scheduled",
        );
        return;
      }
      case "clinic_visit": {
        const d = await this.load<Clinic>(tx, s.org, id, "clinic");
        if (d.state !== "scheduled") throw new AppError("INDUSTRY_STATE", 409);
        if (
          c.outcome !== "cancelled" &&
          new Date(d.data.startsAt!) > new Date()
        )
          throw new AppError("VISIT_NOT_STARTED", 409);
        if (c.outcome !== "visited")
          await tx.query(
            "DELETE FROM industry_slots WHERE organization_id=$1 AND document_id=$2",
            [s.org, id],
          );
        await this.save(
          tx,
          s,
          d,
          `clinic.${c.outcome}`,
          "Статус посещения / Қатысу күйі",
          c.outcome,
        );
        return;
      }
      case "clinic_invoice": {
        const d = await this.load<Clinic>(tx, s.org, id, "clinic");
        if (d.state !== "visited") throw new AppError("INDUSTRY_STATE", 409);
        let [customer] = await tx.query<{ customer_id: string }>(
          "SELECT customer_id FROM clinic_billing_customers WHERE organization_id=$1 AND branch_id=$2",
          [s.org, s.branch],
        );
        if (!customer) {
          const result = await new CrmService(
            this.db,
          ).createCustomerInTransaction(tx, s.secret, s.org, {
            key: stableUuid(`clinic-billing:${s.org}:${s.branch}`),
            branchId: s.branch,
            name: "Обезличенный расчёт / Иесіздендірілген есеп",
            email: "",
            phone: "",
            kind: "person",
            responsibleId: null,
            consents: { email: false, sms: false, messenger: false },
            consentNote: "Без персональных данных / Жеке дерексіз",
          });
          customer = { customer_id: result.id };
          await tx.query(
            "INSERT INTO clinic_billing_customers(organization_id,branch_id,customer_id) VALUES($1,$2,$3)",
            [s.org, s.branch, result.id],
          );
        }
        const item = await this.item(tx, s, d.data.serviceItemId, "service");
        d.data.orderId = await this.invoice(
          tx,
          s,
          id,
          c.key,
          customer.customer_id,
          d.data.warehouseId,
          [
            {
              itemId: item.id,
              unit: item.base_unit,
              quantity: "1",
              price: d.data.price,
              discount: "0",
            },
          ],
          null,
        );
        await this.save(tx, s, d, "clinic.invoiced", "Счёт / Шот", "completed");
        return;
      }
      default:
        throw new AppError("INVALID_INPUT", 422);
    }
  }
}
