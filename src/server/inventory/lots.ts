import { randomUUID } from "node:crypto";
import type { Sql } from "../db/database";
import { AppError } from "../../domain/errors";
import { D } from "../../domain/purchasing";
import type { StockCommand } from "../../domain/inventory";
export type LotContext = { documentId: string; waste?: boolean };
export async function applyLots(
  tx: Sql,
  org: string,
  movement: string,
  c: StockCommand,
  quantity: string,
  previous: string,
  context?: LotContext,
) {
  const tracked =
    (
      await tx.query(
        "SELECT id FROM stock_lots WHERE organization_id=$1 AND item_id=$2 LIMIT 1",
        [org, c.itemId],
      )
    ).length > 0;
  const metadata =
    c.kind === "receipt" || c.kind === "count" ? c.lot : undefined;
  if (!tracked && !metadata) {
    if (c.kind === "issue" && c.lotId)
      throw new AppError("LOT_AVAILABLE_EXCEEDED", 409);
    return;
  }
  const [{ today }] = await tx.query<{ today: string }>(
    "SELECT (now() AT TIME ZONE timezone)::date::text today FROM organizations WHERE id=$1",
    [org],
  );
  const rows = await tx.query<{
    id: string;
    code: string;
    quantity: string;
    expires_on: string | null;
  }>(
    "SELECT id,code,quantity::text,expires_on::text FROM stock_lots WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3 ORDER BY expires_on NULLS LAST,created_at,id FOR UPDATE",
    [org, c.warehouseId, c.itemId],
  );
  if (!rows.reduce((a, l) => a.plus(l.quantity), new D(0)).eq(previous))
    throw new AppError("LOT_OPENING_REQUIRED", 409);
  const allocate = async (lot: string, q: string) => {
    await tx.query(
      "INSERT INTO stock_lot_allocations(organization_id,movement_id,lot_id,quantity) VALUES($1,$2,$3,$4)",
      [org, movement, lot, q],
    );
    await tx.query(
      "UPDATE stock_lots SET quantity=quantity+$3::numeric WHERE organization_id=$1 AND id=$2",
      [org, lot, q],
    );
  };
  const create = async (
    code: string,
    expires: string | null,
    q: string,
    parent: string | null = null,
  ) => {
    if (
      (
        await tx.query(
          "SELECT id FROM stock_lots WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3 AND code=$4",
          [org, c.warehouseId, c.itemId, code],
        )
      ).length
    )
      throw new AppError("LOT_CODE_EXISTS", 409);
    const id = randomUUID();
    await tx.query(
      "INSERT INTO stock_lots(id,organization_id,warehouse_id,item_id,code,expires_on,quantity,received,receipt_id,parent_id) VALUES($1,$2,$3,$4,$5,$6,0,$7,$8,$9)",
      [id, org, c.warehouseId, c.itemId, code, expires, q, movement, parent],
    );
    await allocate(id, q);
  };
  let rest = new D(quantity);
  if (rest.lt(0)) {
    rest = rest.negated();
    const specified = c.kind === "issue" ? c.lotId : undefined;
    for (const l of rows) {
      if (specified && specified !== l.id) continue;
      if (
        l.expires_on &&
        l.expires_on < today &&
        !context?.waste &&
        c.kind !== "count"
      )
        continue;
      const take = D.min(rest, l.quantity);
      if (take.lte(0)) continue;
      await allocate(l.id, take.negated().toFixed());
      rest = rest.minus(take);
      if (rest.eq(0)) break;
    }
    if (rest.gt(0)) throw new AppError("LOT_AVAILABLE_EXCEEDED", 409);
  } else if (rest.gt(0)) {
    if (c.kind === "receipt" || c.kind === "count") {
      if (!metadata) throw new AppError("LOT_REQUIRED", 422);
      await create(metadata.code, metadata.expiresOn, rest.toFixed());
    } else if (c.kind === "return") {
      const source = await tx.query<{ id: string; remaining: string }>(
        `SELECT a.lot_id id,(-a.quantity-coalesce((SELECT sum(r.quantity) FROM stock_lot_allocations r JOIN stock_movements m ON m.organization_id=r.organization_id AND m.id=r.movement_id WHERE r.organization_id=a.organization_id AND r.lot_id=a.lot_id AND m.source_id=$2 AND m.kind='return'),0))::text remaining FROM stock_lot_allocations a WHERE a.organization_id=$1 AND a.movement_id=$2 ORDER BY a.lot_id`,
        [org, c.movementId],
      );
      for (const l of source) {
        const take = D.min(rest, l.remaining);
        if (take.lte(0)) continue;
        await allocate(l.id, take.toFixed());
        rest = rest.minus(take);
        if (rest.eq(0)) break;
      }
      if (rest.gt(0)) throw new AppError("LOT_RETURN_EXCEEDED", 409);
    } else if (c.kind === "receive") {
      const source = await tx.query<{
        id: string;
        code: string;
        expires: string | null;
        quantity: string;
      }>(
        "SELECT l.id,l.code,l.expires_on::text expires,(-a.quantity)::text quantity FROM stock_movements m JOIN stock_lot_allocations a ON a.organization_id=m.organization_id AND a.movement_id=m.id JOIN stock_lots l ON l.organization_id=a.organization_id AND l.id=a.lot_id WHERE m.organization_id=$1 AND m.transfer_id=$2 AND m.kind='dispatch' ORDER BY l.id",
        [org, c.transferId],
      );
      for (const l of source) {
        await create(
          `${l.code.slice(0, 70)}-${c.transferId}`,
          l.expires,
          l.quantity,
          l.id,
        );
        rest = rest.minus(l.quantity);
      }
      if (!rest.eq(0)) throw new AppError("LOT_TRANSFER_MISMATCH", 409);
    } else throw new AppError("LOT_REQUIRED", 422);
  }
}
