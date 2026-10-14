import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type { Sql } from "../db/database";
import { AppError } from "../../domain/errors";

// T030 write-back: a confirmed receipt into a warehouse whose stock MoySklad owns becomes a
// queued supply document there instead of a second local ledger entry. Composed inside the
// receiving transaction, so the receipt and its export are committed together or not at all.
export type SupplySettings = {
  enabled: boolean;
  organization_id: string | null;
  changed_by?: string;
  changed_at?: string;
};
export type SupplyTarget = {
  connectionId: string;
  storeId: string;
  organizationId: string;
  counterpartyId: string;
};
export type SupplyPosition = {
  product: string;
  item_id: string;
  quantity: string;
  value_minor: string;
};
export function supplySettings(settings: unknown): SupplySettings {
  const s = (settings as { supply?: SupplySettings } | null)?.supply;
  return {
    enabled: Boolean(s?.enabled),
    organization_id: s?.organization_id || null,
    changed_by: s?.changed_by,
    changed_at: s?.changed_at,
  };
}
// null: the warehouse keeps its own ledger. Throws when the warehouse is a mirror and the
// receipt cannot be handed to MoySklad as it stands.
export async function supplyTargetInTransaction(
  tx: Sql,
  org: string,
  warehouseId: string,
  supplierId: string,
): Promise<SupplyTarget | null> {
  const [link] = await tx.query<{
    connection_id: string;
    external_store_id: string;
    settings: unknown;
    disconnected_at: string | null;
    credentials: boolean;
  }>(
    "SELECT l.connection_id,l.external_store_id,c.settings,c.disconnected_at,c.credentials IS NOT NULL credentials FROM integration_warehouse_links l JOIN integration_connections c ON c.organization_id=l.organization_id AND c.id=l.connection_id WHERE l.organization_id=$1 AND l.warehouse_id=$2 FOR SHARE OF c",
    [org, warehouseId],
  );
  if (!link) return null;
  const s = supplySettings(link.settings);
  if (
    !s.enabled ||
    !s.organization_id ||
    link.disconnected_at ||
    !link.credentials
  )
    throw new AppError("EXTERNAL_SOURCE_OF_TRUTH", 409);
  const [party] = await tx.query<{ external_id: string }>(
    "SELECT external_id FROM integration_mappings WHERE connection_id=$1 AND entity_type='counterparty' AND internal_id=$2 AND state='active'",
    [link.connection_id, supplierId],
  );
  if (!party) throw new AppError("EXTERNAL_COUNTERPARTY_UNMAPPED", 422);
  return {
    connectionId: link.connection_id,
    storeId: link.external_store_id,
    organizationId: s.organization_id,
    counterpartyId: party.external_id,
  };
}
export async function externalProductInTransaction(
  tx: Sql,
  connectionId: string,
  itemId: string,
) {
  const [m] = await tx.query<{ external_id: string }>(
    "SELECT external_id FROM integration_mappings WHERE connection_id=$1 AND entity_type='product' AND internal_id=$2 AND state='active'",
    [connectionId, itemId],
  );
  if (!m) throw new AppError("EXTERNAL_PRODUCT_UNMAPPED", 422);
  return m.external_id;
}
export async function queueSupplyInTransaction(
  tx: Sql,
  org: string,
  actorId: string,
  input: {
    target: SupplyTarget;
    sourceId: string;
    orderId: string;
    orderNumber: string;
    warehouseId: string;
    note: string;
    positions: SupplyPosition[];
  },
) {
  const expected = input.positions.reduce(
    (sum, p) => sum + BigInt(p.value_minor),
    0n,
  );
  const id = randomUUID();
  await tx.query(
    "INSERT INTO integration_exports(id,organization_id,connection_id,kind,source_type,source_id,purchase_order_id,warehouse_id,payload,expected_minor,state,created_by) VALUES($1,$2,$3,'supply','purchase_receive',$4,$5,$6,$7,$8,'pending',$9)",
    [
      id,
      org,
      input.target.connectionId,
      input.sourceId,
      input.orderId,
      input.warehouseId,
      JSON.stringify({
        organization: input.target.organizationId,
        agent: input.target.counterpartyId,
        store: input.target.storeId,
        order_number: input.orderNumber,
        note: input.note,
        positions: input.positions,
      }),
      expected.toString(),
      actorId,
    ],
  );
  return { id, expected_minor: expected.toString() };
}
// MoySklad takes a per-unit price in minor units. The line value is exact in tiyn; the unit
// price is rounded to 1/10000 tiyn and the document sum is compared back after creation.
export function unitPriceMinor(valueMinor: string, quantity: string) {
  return new Decimal(valueMinor).div(quantity).toDecimalPlaces(4).toFixed();
}
export const externalCode = (exportId: string) => `taraz-${exportId}`;
